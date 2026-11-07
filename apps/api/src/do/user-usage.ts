import { drizzle } from "drizzle-orm/d1";
import { usageLog } from "../db/schema";
import type { ApiEnv } from "../env";
import { normalizeSessionId, parseOpenAiUsage, type ParsedUsage } from "../util/usage";
import {
  estimateCostMicro,
  type RoutePrice,
  type UsageLimits,
} from "../util/usage";

export type UpstreamRoute = "club-lumen" | "byok" | "opencode-go" | "sarvam";
export type DenyReason = "five_hour_cap" | "weekly_cap" | "no_upstream";

export interface WindowSnapshot {
  usedMicro: number;
  limitMicro: number;
  startMs: number;
  resetsInMs: number;
}

export interface UsageSnapshot {
  fiveHour: WindowSnapshot;
  weekly: WindowSnapshot;
  pendingMicro: number;
}

export interface AdmitInput {
  requestId: string;
  sessionId: string;
  userId: string;
  apiKeyId: string;
  model: string;
  createdAt: number;
  inputEstimateTokens: number;
  maxOutputTokens: number;
  limits: UsageLimits;
  // Availability snapshot from the worker. Club-level upstream state is an
  // observation, not a reservation: upstreams enforce their own limits, so a
  // stale-by-seconds view only affects routing preference, never correctness.
  upstreams: { clubLumen: "ok" | "dry"; byok: boolean; opencodeGo: boolean; sarvam: boolean };
  // Set when the club's Sarvam account serves this model, which is then routed
  // to Sarvam alone. The model catalog knows which provider owns each model.
  sarvamPriced?: boolean;
  prices: { clubLumen: RoutePrice; opencodeGo?: RoutePrice; sarvam?: RoutePrice };
}

export type AdmitResult =
  | { decision: "admit"; route: UpstreamRoute; reservedMicro: number; snapshot: UsageSnapshot }
  | { decision: "deny"; reason: DenyReason; snapshot: UsageSnapshot };

export interface SettleInput {
  requestId: string;
  route: UpstreamRoute;
  // Actual cost, or zero when usage is unavailable.
  costMicro: number;
  usage: ParsedUsage | null;
  status: "ok" | "error" | "aborted";
  estimated: boolean;
  durationMs: number;
  limits: UsageLimits;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const SESSION_STICKINESS_MS = 60 * 60 * 1000;

const WINDOW_NAMES = ["five_hour", "weekly"] as const;
type WindowName = (typeof WINDOW_NAMES)[number];

const windowDurations: Record<WindowName, number> = { five_hour: FIVE_HOUR_MS, weekly: WEEK_MS };

interface WindowRow {
  name: string;
  start_ms: number;
  used_micro: number;
}

interface ReservationRow {
  id: string;
  route: string;
  cost_micro: number;
  expires_at_ms: number;
}

// JSON-safe copy of the D1 record. Request bodies are never persisted.
type UsageRecord = Omit<typeof usageLog.$inferSelect, "createdAt"> & { createdAt: number };
interface RequestRow {
  id: string;
  record: string;
  settled: number;
  version: number;
  synced_version: number;
  five_hour_start: number;
  weekly_start: number;
}

/**
 * Per-user usage state: two tumbling cost windows (five hours and a week),
 * reservations bounding concurrent in-flight requests, and per-session route
 * stickiness for prompt-cache affinity.
 *
 * Windows advance only on traffic: the first admission after a window expires
 * re-anchors it to that request, so an idle user keeps the same window (and
 * its spent budget) until they return. The alarm never resets windows; it only
 * sweeps expired reservations and retries log syncs. Expired reservations
 * are released without turning a maximum-output estimate into spend.
 * All state mutations run in synchronous SQLite
 * sections after the request body is read, which the Durable Object input gate
 * makes atomic.
 */
export class UserUsage implements DurableObject {
  private schemaReady = false;
  private syncing: Promise<void> | undefined;
  private initialized = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ApiEnv,
  ) { }

  async fetch(request: Request): Promise<Response> {
    // Read the body first: awaiting it can interleave with another request,
    // so no storage work happens before this point.
    const input = await request.json().catch(() => null);
    this.ensureSchema();

    const userId = input && typeof input === "object" && "userId" in input && typeof input.userId === "string" ? input.userId : null;
    if (!userId) return new Response("Missing user", { status: 400 });
    await this.initializeAccounting(userId);
    const path = new URL(request.url).pathname;
    let result: unknown;
    if (path === "/admit") {
      const admit = parseAdmitInput(input);
      result = admit ? this.admit(admit) : undefined;
    } else if (path === "/settle") {
      const settle = parseSettleInput(input);
      result = settle ? this.settle(settle) : undefined;
    } else if (path === "/status") {
      const limits = parseLimits(input);
      result = limits ? this.status(limits) : undefined;
    }
    if (result === undefined) return new Response("Bad request", { status: 400 });

    await this.syncAlarm();
    // The journal and charge are already committed. D1 is a retryable copy.
    await this.syncLogs();
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    // Windows are deliberately left alone: they advance only on the next
    // admission, so an idle user's spent budget carries into their next
    // window instead of resetting on a timer.
    this.sweepReservations(now);
    this.exec(`DELETE FROM session_routes WHERE updated_at_ms < ?`, now - SESSION_STICKINESS_MS);
    this.exec(`DELETE FROM requests WHERE synced_version = version AND json_extract(record, '$.status') != 'pending' AND json_extract(record, '$.createdAt') < ?`, now - 30 * 24 * 60 * 60 * 1000);
    await this.syncLogs();
    await this.syncAlarm();
  }

  private async initializeAccounting(userId: string): Promise<void> {
    if (this.initialized) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get<boolean>("accounting-actual-usage-v2")) {
        this.initialized = true;
        return;
      }
      // Repair both copies of historical estimates before rebuilding counters.
      // Block new requests so a settlement cannot race the repair. Sync first
      // so rebuilding from D1 also includes any previously unsynced actual usage.
      await this.syncLogs();
      if (this.one<{ id: string }>(`SELECT id FROM requests WHERE version > synced_version LIMIT 1`)) {
        throw new Error("Cannot repair accounting while usage logs are unsynced");
      }
      await this.env.DB.prepare(
        `UPDATE usage_log SET cost_micro = 0 WHERE user_id = ? AND estimated = 1 AND input_tokens IS NULL AND output_tokens IS NULL AND cost_micro != 0`,
      ).bind(userId).run();
      this.exec(
        `UPDATE requests SET record = json_set(record, '$.costMicro', 0), version = version + 1
         WHERE json_extract(record, '$.estimated') = 1
           AND json_extract(record, '$.inputTokens') IS NULL
           AND json_extract(record, '$.outputTokens') IS NULL
           AND json_extract(record, '$.costMicro') != 0`,
      );
      const windows = this.all<WindowRow>(`SELECT * FROM windows`);
      for (const window of windows) {
        const total = await this.env.DB.prepare(
          `SELECT COALESCE(SUM(cost_micro), 0) AS total FROM usage_log WHERE user_id = ? AND billed = 'club' AND created_at >= ?`,
        ).bind(userId, window.start_ms).first<{ total: number }>();
        this.exec(`UPDATE windows SET used_micro = ? WHERE name = ?`, total?.total ?? 0, window.name);
      }
      this.exec(`DELETE FROM reservations WHERE id NOT IN (SELECT id FROM requests)`);
      await this.state.storage.put("accounting-actual-usage-v2", true);
      this.initialized = true;
    });
  }

  private admit(input: AdmitInput): AdmitResult {
    const now = Date.now();
    this.refreshWindows(now);
    this.sweepReservations(now);

    const snapshot = this.snapshot(input.limits, now);

    // Candidate routes in priority order: club Lumen first, then the club's
    // OpenCode Go allocation while allowance remains, then the user's own key.
    // A model is offered by exactly one club upstream, so only the owner is
    // considered before the user's own key.
    const candidates: UpstreamRoute[] = [];
    if (input.sarvamPriced) {
      if (input.upstreams.sarvam) candidates.push("sarvam");
    } else if (input.upstreams.clubLumen === "ok") {
      candidates.push("club-lumen");
    }
    if (input.upstreams.opencodeGo && input.prices.opencodeGo) candidates.push("opencode-go");
    if (input.upstreams.byok) candidates.push("byok");

    // Prefer the route this session already uses while it stays available, so
    // route changes do not thrash prompt caches. BYOK is never sticky: the
    // club's own upstreams win back traffic as soon as they can serve it.
    const sticky = this.stickyRoute(input.sessionId, now);
    if (sticky && candidates.includes(sticky)) {
      candidates.splice(candidates.indexOf(sticky), 1);
      candidates.unshift(sticky);
    }

    let capReason: DenyReason | null = null;
    for (const route of candidates) {
      if (route === "byok") {
        this.state.storage.transactionSync(() => {
          this.recordAdmission(input, route, "pending");
          this.exec(`INSERT INTO reservations (id, route, cost_micro, expires_at_ms) VALUES (?, ?, 0, ?)`, input.requestId, route, now + RESERVATION_TTL_MS);
        });
        return { decision: "admit", route, reservedMicro: 0, snapshot };
      }

      const price = route === "club-lumen"
        ? input.prices.clubLumen
        : route === "sarvam"
          ? input.prices.sarvam!
          : input.prices.opencodeGo!;
      const reservedMicro = estimateCostMicro(input, price);
      const fiveHourFits =
        snapshot.fiveHour.usedMicro + snapshot.pendingMicro + reservedMicro <= input.limits.fiveHourMicro;
      const weeklyFits =
        snapshot.weekly.usedMicro + snapshot.pendingMicro + reservedMicro <= input.limits.weeklyMicro;

      if (fiveHourFits && weeklyFits) {
        this.state.storage.transactionSync(() => {
          this.recordAdmission(input, route, "pending");
          this.exec(
            `INSERT OR REPLACE INTO reservations (id, route, cost_micro, expires_at_ms) VALUES (?, ?, ?, ?)`,
            input.requestId, route, reservedMicro, now + RESERVATION_TTL_MS,
          );
          this.exec(
            `INSERT INTO session_routes (session_id, route, updated_at_ms) VALUES (?, ?, ?)
             ON CONFLICT (session_id) DO UPDATE SET route = excluded.route, updated_at_ms = excluded.updated_at_ms`,
            input.sessionId, route, now,
          );
        });
        return { decision: "admit", route, reservedMicro, snapshot };
      }
      capReason = fiveHourFits ? "weekly_cap" : "five_hour_cap";
    }

    this.recordAdmission(input, "club-lumen", "denied");
    return { decision: "deny", reason: capReason ?? "no_upstream", snapshot };
  }

  private recordAdmission(input: AdmitInput, route: UpstreamRoute, status: "pending" | "denied"): void {
    const record: UsageRecord = {
      id: input.requestId, userId: input.userId, apiKeyId: input.apiKeyId,
      sessionId: input.sessionId, model: input.model, upstream: route,
      billed: route === "byok" ? "personal" : "club", inputTokens: null,
      outputTokens: null, cachedTokens: null, costMicro: 0, estimated: false,
      status, durationMs: status === "denied" ? 0 : null, createdAt: input.createdAt,
    };
    const fiveHour = this.one<WindowRow>(`SELECT * FROM windows WHERE name = 'five_hour'`)!;
    const weekly = this.one<WindowRow>(`SELECT * FROM windows WHERE name = 'weekly'`)!;
    this.exec(
      `INSERT INTO requests (id, record, settled, version, synced_version, five_hour_start, weekly_start)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
      input.requestId, JSON.stringify(record), status === "denied" ? 1 : 0, fiveHour.start_ms, weekly.start_ms,
    );
  }

  private settle(input: SettleInput): UsageSnapshot {
    const now = Date.now();
    // No refreshWindows here: a late settlement is not new traffic and must
    // not re-anchor an expired window. The charge lands in the request's own
    // window if that window is still current, and is dropped otherwise.
    const row = this.one<RequestRow>(`SELECT * FROM requests WHERE id = ?`, input.requestId);
    if (row && !row.settled) {
      const record: UsageRecord = JSON.parse(row.record);
      // Late usage is charged only in windows that still contain this request.
      const previousCost = record.billed === "club" ? record.costMicro : 0;
      record.upstream = input.route;
      record.billed = input.route === "byok" ? "personal" : "club";
      record.costMicro = input.usage === null ? 0 : input.costMicro;
      record.inputTokens = input.usage?.inputTokens ?? null;
      record.outputTokens = input.usage?.outputTokens ?? null;
      record.cachedTokens = input.usage?.cachedTokens ?? null;
      record.status = input.status;
      record.estimated = input.estimated;
      record.durationMs = input.durationMs;
      const cost = record.billed === "club" ? record.costMicro : 0;
      this.state.storage.transactionSync(() => {
        this.adjustCharge(row, cost - previousCost);
        this.exec(`DELETE FROM reservations WHERE id = ?`, input.requestId);
        this.exec(`UPDATE requests SET record = ?, settled = 1, version = version + 1 WHERE id = ?`, JSON.stringify(record), input.requestId);
      });
    }
    return this.snapshot(input.limits, now);
  }

  private adjustCharge(row: RequestRow, delta: number): void {
    this.exec(`UPDATE windows SET used_micro = MAX(0, used_micro + ?) WHERE name = 'five_hour' AND start_ms = ?`, delta, row.five_hour_start);
    this.exec(`UPDATE windows SET used_micro = MAX(0, used_micro + ?) WHERE name = 'weekly' AND start_ms = ?`, delta, row.weekly_start);
  }

  private status(limits: UsageLimits): UsageSnapshot {
    const now = Date.now();
    this.sweepReservations(now);
    // Read-only: viewing usage must not start a window. An expired window is
    // reported as empty and "resetting now" until the next admission consumes
    // the reset and re-anchors it.
    return this.snapshot(limits, now);
  }

  // Advances expired windows to `now`, so the caller that triggered this
  // (an admission or a settlement) becomes the new anchor. Called from every
  // admission so enforcement re-anchors on traffic and never on a timer.
  private refreshWindows(now: number): void {
    for (const name of WINDOW_NAMES) {
      const row = this.one<WindowRow>(`SELECT name, start_ms, used_micro FROM windows WHERE name = ?`, name);
      // Windows anchor at first use; a missing or expired window starts fresh.
      if (!row || now - row.start_ms >= windowDurations[name]) {
        this.exec(
          `INSERT INTO windows (name, start_ms, used_micro) VALUES (?, ?, 0)
           ON CONFLICT (name) DO UPDATE SET start_ms = excluded.start_ms, used_micro = 0`,
          name, now,
        );
      }
    }
  }

  private sweepReservations(now: number): void {
    const expired = this.all<ReservationRow>(
      `SELECT id, route, cost_micro, expires_at_ms FROM reservations WHERE expires_at_ms <= ?`,
      now,
    );
    for (const reservation of expired) {
      const row = this.one<RequestRow>(`SELECT * FROM requests WHERE id = ?`, reservation.id);
      this.state.storage.transactionSync(() => {
        if (row) {
          const record: UsageRecord = JSON.parse(row.record);
          record.status = "aborted";
          record.estimated = true;
          record.costMicro = 0;
          record.durationMs = now - record.createdAt;
          // Keep the request so a late settlement can still record actual usage.
          this.exec(`UPDATE requests SET record = ?, version = version + 1 WHERE id = ?`, JSON.stringify(record), row.id);
        }
        // Legacy reservations have no recoverable request metadata. Release
        // them instead of creating another unlogged charge.
        this.exec(`DELETE FROM reservations WHERE id = ?`, reservation.id);
      });
    }
  }

  private syncLogs(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        let rows = this.all<RequestRow>(`SELECT * FROM requests WHERE version > synced_version LIMIT 50`);
        while (rows.length > 0) {
          for (const row of rows) {
            const record: UsageRecord = JSON.parse(row.record);
            const values = { ...record, sessionId: record.sessionId === null ? null : normalizeSessionId(record.sessionId), createdAt: new Date(record.createdAt) };
            await drizzle(this.env.DB).insert(usageLog).values(values)
              .onConflictDoUpdate({ target: usageLog.id, set: values });
            this.exec(`UPDATE requests SET synced_version = ? WHERE id = ?`, row.version, row.id);
          }
          rows = this.all<RequestRow>(`SELECT * FROM requests WHERE version > synced_version LIMIT 50`);
        }
      } catch (error) {
        console.error("usage journal sync failed", error);
        // Retain dirty records and arrange a retry even if no more traffic arrives.
        const current = await this.state.storage.getAlarm();
        const retryAt = Date.now() + 30_000;
        if (current === null || current > retryAt) await this.state.storage.setAlarm(retryAt);
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private snapshot(limits: UsageLimits, now: number): UsageSnapshot {
    const rows = this.all<WindowRow>(`SELECT name, start_ms, used_micro FROM windows`);
    const byName = new Map(rows.map((row) => [row.name, row]));
    const pendingMicro = this.one<{ total: number }>(
      `SELECT COALESCE(SUM(cost_micro), 0) AS total FROM reservations`,
    )?.total ?? 0;

    const window = (name: WindowName, limitMicro: number): WindowSnapshot => {
      const row = byName.get(name);
      const startMs = row?.start_ms ?? now;
      const expired = !row || now - startMs >= windowDurations[name];
      // Missing and expired windows start on the next request. Report them
      // as empty with no time left without starting them here.
      return {
        usedMicro: expired ? 0 : row?.used_micro ?? 0,
        limitMicro,
        startMs,
        resetsInMs: expired ? 0 : Math.max(0, startMs + windowDurations[name] - now),
      };
    };

    return {
      fiveHour: window("five_hour", limits.fiveHourMicro),
      weekly: window("weekly", limits.weeklyMicro),
      pendingMicro,
    };
  }

  private stickyRoute(sessionId: string, now: number): UpstreamRoute | null {
    const row = this.one<{ route: string; updated_at_ms: number }>(
      `SELECT route, updated_at_ms FROM session_routes WHERE session_id IN (?, ?) ORDER BY updated_at_ms DESC LIMIT 1`,
      sessionId, /^ses_[0-9a-f]{16}$/.test(sessionId) ? sessionId.slice(4) : sessionId,
    );
    if (!row || now - row.updated_at_ms > SESSION_STICKINESS_MS) return null;
    return row.route as UpstreamRoute;
  }

  // Preserve an earlier alarm when reservations or unsynced logs need attention.
  // Windows are not scheduled here: they advance on admission, not on a timer.
  private async syncAlarm(): Promise<void> {
    const now = Date.now();
    const times: number[] = [];
    const nextReservation = this.one<{ next: number }>(
      `SELECT MIN(expires_at_ms) AS next FROM reservations`,
    )?.next;
    if (typeof nextReservation === "number") times.push(nextReservation);
    if (this.one<{ id: string }>(`SELECT id FROM requests WHERE version > synced_version LIMIT 1`)) {
      times.push(now + 30_000);
    }
    if (times.length === 0) {
      // Nothing to wait for. Clear any alarm left by an older version that
      // scheduled window resets, so idle objects stop waking up.
      if (await this.state.storage.getAlarm() !== null) await this.state.storage.deleteAlarm();
      return;
    }

    const desired = Math.max(Math.min(...times), now + 1000);
    const current = await this.state.storage.getAlarm();
    if (current !== null && current <= desired) return;
    await this.state.storage.setAlarm(desired);
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.exec(`CREATE TABLE IF NOT EXISTS windows (
      name TEXT PRIMARY KEY,
      start_ms INTEGER NOT NULL,
      used_micro INTEGER NOT NULL
    )`);
    this.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      cost_micro INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    )`);
    this.exec(`CREATE TABLE IF NOT EXISTS session_routes (
      session_id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    this.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      settled INTEGER NOT NULL,
      version INTEGER NOT NULL,
      synced_version INTEGER NOT NULL,
      five_hour_start INTEGER NOT NULL,
      weekly_start INTEGER NOT NULL
    )`);
    this.schemaReady = true;
  }

  private exec(query: string, ...params: (string | number)[]): void {
    this.state.storage.sql.exec(query, ...params).toArray();
  }

  private all<T>(query: string, ...params: (string | number)[]): T[] {
    return this.state.storage.sql.exec(query, ...params).toArray() as T[];
  }

  private one<T>(query: string, ...params: (string | number)[]): T | null {
    return this.all<T>(query, ...params)[0] ?? null;
  }
}

function parseLimits(raw: unknown): UsageLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const limits = record.limits && typeof record.limits === "object"
    ? record.limits as Record<string, unknown>
    : null;
  if (!limits) return null;
  const fiveHourMicro = typeof limits.fiveHourMicro === "number" ? limits.fiveHourMicro : null;
  const weeklyMicro = typeof limits.weeklyMicro === "number" ? limits.weeklyMicro : null;
  if (fiveHourMicro === null || weeklyMicro === null) return null;
  return { fiveHourMicro, weeklyMicro };
}

function parseAdmitInput(raw: unknown): AdmitInput | null {
  const limits = parseLimits(raw);
  if (!raw || typeof raw !== "object" || !limits) return null;
  const record = raw as Record<string, unknown>;
  const upstreams = record.upstreams && typeof record.upstreams === "object"
    ? record.upstreams as Record<string, unknown>
    : null;
  const prices = record.prices && typeof record.prices === "object"
    ? record.prices as Record<string, unknown>
    : null;
  if (!upstreams || !prices) return null;
  const clubLumen = upstreams.clubLumen === "dry" ? "dry" : "ok";
  const price = (value: unknown): RoutePrice | null => {
    if (!value || typeof value !== "object") return null;
    const p = value as Record<string, unknown>;
    if (typeof p.input !== "number" || typeof p.output !== "number" || typeof p.cacheRead !== "number") return null;
    return { input: p.input, output: p.output, cacheRead: p.cacheRead };
  };
  const clubLumenPrice = price(prices.clubLumen);
  if (
    typeof record.requestId !== "string" || typeof record.sessionId !== "string" ||
    typeof record.userId !== "string" || typeof record.apiKeyId !== "string" ||
    typeof record.model !== "string" || typeof record.createdAt !== "number" ||
    typeof record.inputEstimateTokens !== "number" || typeof record.maxOutputTokens !== "number" ||
    !clubLumenPrice
  ) return null;
  // JSON.stringify drops undefined members, so an absent price means Lumen.
  const sarvamPriced = record.sarvamPriced === true;
  if (sarvamPriced && !price(prices.sarvam)) return null;
  return {
    requestId: record.requestId,
    sessionId: record.sessionId,
    userId: record.userId,
    apiKeyId: record.apiKeyId,
    model: record.model,
    createdAt: record.createdAt,
    inputEstimateTokens: record.inputEstimateTokens,
    maxOutputTokens: record.maxOutputTokens,
    limits,
    upstreams: {
      clubLumen,
      byok: upstreams.byok === true,
      opencodeGo: upstreams.opencodeGo === true,
      sarvam: upstreams.sarvam === true,
    },
    sarvamPriced,
    prices: {
      clubLumen: clubLumenPrice,
      opencodeGo: price(prices.opencodeGo) ?? undefined,
      sarvam: sarvamPriced ? price(prices.sarvam)! : undefined,
    },
  };
}

function parseSettleInput(raw: unknown): SettleInput | null {
  const limits = parseLimits(raw);
  if (!raw || typeof raw !== "object" || !limits) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.requestId !== "string" || typeof record.route !== "string") return null;
  if (record.route !== "club-lumen" && record.route !== "byok" && record.route !== "opencode-go" && record.route !== "sarvam") return null;
  if (typeof record.costMicro !== "number" || !Number.isFinite(record.costMicro) || record.costMicro < 0) return null;
  if (record.status !== "ok" && record.status !== "error" && record.status !== "aborted") return null;
  if (typeof record.estimated !== "boolean" || typeof record.durationMs !== "number") return null;
  const usage = record.usage;
  const parsedUsage = usage && typeof usage === "object" ? parseOpenAiUsage({
    prompt_tokens: (usage as ParsedUsage).inputTokens,
    completion_tokens: (usage as ParsedUsage).outputTokens,
    prompt_tokens_details: { cached_tokens: (usage as ParsedUsage).cachedTokens },
  }) : null;
  if (usage != null && !parsedUsage) return null;
  return {
    requestId: record.requestId,
    route: record.route,
    costMicro: record.costMicro,
    usage: parsedUsage,
    status: record.status,
    estimated: record.estimated,
    durationMs: record.durationMs,
    limits,
  };
}
