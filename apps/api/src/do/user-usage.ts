import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { usageLog } from "../db/schema";
import type { ApiEnv } from "../env";
import type { UpstreamRoute } from "../upstreams";
import type { ParsedUsage, UsageLimits } from "../util/usage";

export type DenyReason = "five_hour_cap" | "weekly_cap";

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
  // Available routes in priority order. Never empty.
  routes: UpstreamRoute[];
  // Worst-case cost of the request on a club route.
  reserveMicro: number;
  limits: UsageLimits;
}

export type AdmitResult =
  | { decision: "admit"; route: UpstreamRoute; snapshot: UsageSnapshot }
  | { decision: "deny"; reason: DenyReason; snapshot: UsageSnapshot };

export interface SettleInput {
  requestId: string;
  route: UpstreamRoute;
  usage: ParsedUsage | null;
  // Cost of `usage`. Ignored when usage is unknown.
  costMicro: number;
  status: "ok" | "error" | "aborted";
  durationMs: number;
  limits: UsageLimits;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const SESSION_STICKINESS_MS = 60 * 60 * 1000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_RETRY_MS = 30_000;

const WINDOW_NAMES = ["five_hour", "weekly"] as const;
type WindowName = (typeof WINDOW_NAMES)[number];

const windowDurations: Record<WindowName, number> = { five_hour: FIVE_HOUR_MS, weekly: WEEK_MS };

interface WindowRow {
  name: string;
  start_ms: number;
  used_micro: number;
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
 * reservations for in-flight requests, and per-session route stickiness for
 * prompt-cache affinity.
 *
 * Limits guarantee at least the allowance: a request is admitted while spend
 * plus in-flight reservations is under the limit, so the last request in a
 * window may run over.
 *
 * Windows advance only on traffic: the first admission after a window expires
 * re-anchors it, so an idle user keeps their window until they return. The
 * alarm only sweeps expired reservations and retries log syncs.
 *
 * Every public method mutates storage synchronously before its first await,
 * so the input gate makes each one atomic. The `requests` table is a journal
 * that is mirrored to D1 and retried until synced.
 */
export class UserUsage extends DurableObject<ApiEnv> {
  private syncing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: ApiEnv) {
    super(ctx, env);
    this.createSchema();
  }

  async admit(input: AdmitInput): Promise<AdmitResult> {
    const result = this.decideAdmission(input);
    await this.syncAlarm();
    // The alarm retries the sync, so admission does not wait on D1.
    void this.syncLogs();
    return result;
  }

  async settle(input: SettleInput): Promise<UsageSnapshot> {
    const result = this.recordSettlement(input);
    await this.syncAlarm();
    await this.syncLogs();
    return result;
  }

  async status(limits: UsageLimits): Promise<UsageSnapshot> {
    const now = Date.now();
    this.sweepReservations(now);
    // Read-only: viewing usage must not start a window.
    const result = this.snapshot(limits, now);
    await this.syncAlarm();
    return result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.sweepReservations(now);
    this.exec(`DELETE FROM session_routes WHERE updated_at_ms < ?`, now - SESSION_STICKINESS_MS);
    this.exec(
      `DELETE FROM requests WHERE synced_version = version AND json_extract(record, '$.status') != 'pending' AND json_extract(record, '$.createdAt') < ?`,
      now - LOG_RETENTION_MS,
    );
    await this.syncLogs();
    await this.syncAlarm();
  }

  private decideAdmission(input: AdmitInput): AdmitResult {
    const now = Date.now();
    this.refreshWindows(now);
    this.sweepReservations(now);
    const snapshot = this.snapshot(input.limits, now);

    const reason: DenyReason | null =
      snapshot.fiveHour.usedMicro + snapshot.pendingMicro >= snapshot.fiveHour.limitMicro ? "five_hour_cap"
        : snapshot.weekly.usedMicro + snapshot.pendingMicro >= snapshot.weekly.limitMicro ? "weekly_cap"
          : null;

    const clubRoutes: UpstreamRoute[] = input.routes.filter((route) => route !== "byok");
    const hasByok = input.routes.includes("byok");
    let route: UpstreamRoute | null;
    if (reason) {
      // Over the club allowance, the user's own key still serves.
      route = hasByok ? "byok" : null;
    } else {
      // Stay on the session's current route so prompt caches stay warm.
      const sticky = this.stickyRoute(input.sessionId, now);
      route = sticky && clubRoutes.includes(sticky) ? sticky : clubRoutes[0] ?? "byok";
    }

    if (!route) {
      this.recordAdmission(input, input.routes[0]!, "denied");
      return { decision: "deny", reason: reason!, snapshot };
    }

    const reservedMicro = route === "byok" ? 0 : input.reserveMicro;
    this.ctx.storage.transactionSync(() => {
      this.recordAdmission(input, route, "pending");
      this.exec(
        `INSERT INTO reservations (id, route, cost_micro, expires_at_ms) VALUES (?, ?, ?, ?)`,
        input.requestId, route, reservedMicro, now + RESERVATION_TTL_MS,
      );
      // The user's own key is never sticky: club routes win traffic back as
      // soon as they can serve it.
      if (route !== "byok") {
        this.exec(
          `INSERT INTO session_routes (session_id, route, updated_at_ms) VALUES (?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE SET route = excluded.route, updated_at_ms = excluded.updated_at_ms`,
          input.sessionId, route, now,
        );
      }
    });
    return { decision: "admit", route, snapshot };
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

  private recordSettlement(input: SettleInput): UsageSnapshot {
    // No refreshWindows: a late settlement is not new traffic and must not
    // re-anchor a window. The charge lands in the request's own windows if
    // they are still current.
    const row = this.one<RequestRow>(`SELECT * FROM requests WHERE id = ?`, input.requestId);
    if (row && !row.settled) {
      const record: UsageRecord = JSON.parse(row.record);
      const previousCost = record.billed === "club" ? record.costMicro : 0;
      record.upstream = input.route;
      record.billed = input.route === "byok" ? "personal" : "club";
      record.costMicro = input.usage === null ? 0 : input.costMicro;
      record.inputTokens = input.usage?.inputTokens ?? null;
      record.outputTokens = input.usage?.outputTokens ?? null;
      record.cachedTokens = input.usage?.cachedTokens ?? null;
      record.status = input.status;
      // Unknown usage on a non-error response is recorded at zero cost.
      record.estimated = input.usage === null && input.status !== "error";
      record.durationMs = input.durationMs;
      const cost = record.billed === "club" ? record.costMicro : 0;
      this.ctx.storage.transactionSync(() => {
        this.adjustCharge(row, cost - previousCost);
        this.exec(`DELETE FROM reservations WHERE id = ?`, input.requestId);
        this.exec(`UPDATE requests SET record = ?, settled = 1, version = version + 1 WHERE id = ?`, JSON.stringify(record), input.requestId);
      });
    }
    return this.snapshot(input.limits, Date.now());
  }

  private adjustCharge(row: RequestRow, delta: number): void {
    this.exec(`UPDATE windows SET used_micro = MAX(0, used_micro + ?) WHERE name = 'five_hour' AND start_ms = ?`, delta, row.five_hour_start);
    this.exec(`UPDATE windows SET used_micro = MAX(0, used_micro + ?) WHERE name = 'weekly' AND start_ms = ?`, delta, row.weekly_start);
  }

  // Starts a fresh window anchored at `now` for any missing or expired one.
  private refreshWindows(now: number): void {
    for (const name of WINDOW_NAMES) {
      const row = this.one<WindowRow>(`SELECT * FROM windows WHERE name = ?`, name);
      if (!row || now - row.start_ms >= windowDurations[name]) {
        this.exec(
          `INSERT INTO windows (name, start_ms, used_micro) VALUES (?, ?, 0)
           ON CONFLICT (name) DO UPDATE SET start_ms = excluded.start_ms, used_micro = 0`,
          name, now,
        );
      }
    }
  }

  // Releases reservations whose request never settled, at zero cost. The
  // request stays unsettled so a late settlement can still record usage.
  private sweepReservations(now: number): void {
    const expired = this.all<{ id: string }>(`SELECT id FROM reservations WHERE expires_at_ms <= ?`, now);
    for (const { id } of expired) {
      const row = this.one<RequestRow>(`SELECT * FROM requests WHERE id = ?`, id);
      this.ctx.storage.transactionSync(() => {
        if (row) {
          const record: UsageRecord = JSON.parse(row.record);
          record.status = "aborted";
          record.estimated = true;
          record.costMicro = 0;
          record.durationMs = now - record.createdAt;
          this.exec(`UPDATE requests SET record = ?, version = version + 1 WHERE id = ?`, JSON.stringify(record), id);
        }
        this.exec(`DELETE FROM reservations WHERE id = ?`, id);
      });
    }
  }

  private syncLogs(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const db = drizzle(this.env.DB);
        let rows = this.unsyncedRequests();
        while (rows.length > 0) {
          for (const row of rows) {
            const record: UsageRecord = JSON.parse(row.record);
            const values = { ...record, createdAt: new Date(record.createdAt) };
            await db.insert(usageLog).values(values).onConflictDoUpdate({ target: usageLog.id, set: values });
            this.exec(`UPDATE requests SET synced_version = ? WHERE id = ?`, row.version, row.id);
          }
          rows = this.unsyncedRequests();
        }
      } catch (error) {
        console.error("usage journal sync failed", error);
        await this.scheduleAlarm(Date.now() + SYNC_RETRY_MS);
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private unsyncedRequests(): RequestRow[] {
    return this.all<RequestRow>(`SELECT * FROM requests WHERE version > synced_version LIMIT 50`);
  }

  private snapshot(limits: UsageLimits, now: number): UsageSnapshot {
    const rows = new Map(this.all<WindowRow>(`SELECT * FROM windows`).map((row) => [row.name, row]));
    const pendingMicro = this.one<{ total: number }>(`SELECT COALESCE(SUM(cost_micro), 0) AS total FROM reservations`)!.total;

    // Missing and expired windows are reported as empty and resetting now.
    // The next admission starts them.
    const window = (name: WindowName, limitMicro: number): WindowSnapshot => {
      const row = rows.get(name);
      const live = row && now - row.start_ms < windowDurations[name];
      return {
        usedMicro: live ? row.used_micro : 0,
        limitMicro,
        startMs: row?.start_ms ?? now,
        resetsInMs: live ? row.start_ms + windowDurations[name] - now : 0,
      };
    };

    return {
      fiveHour: window("five_hour", limits.fiveHourMicro),
      weekly: window("weekly", limits.weeklyMicro),
      pendingMicro,
    };
  }

  private stickyRoute(sessionId: string, now: number): UpstreamRoute | null {
    const row = this.one<{ route: UpstreamRoute; updated_at_ms: number }>(
      `SELECT route, updated_at_ms FROM session_routes WHERE session_id = ?`,
      sessionId,
    );
    return row && now - row.updated_at_ms <= SESSION_STICKINESS_MS ? row.route : null;
  }

  // Wakes for the next reservation expiry, or soon if logs are unsynced.
  private async syncAlarm(): Promise<void> {
    const times: number[] = [];
    const nextReservation = this.one<{ next: number | null }>(`SELECT MIN(expires_at_ms) AS next FROM reservations`)!.next;
    if (nextReservation !== null) times.push(nextReservation);
    if (this.one(`SELECT id FROM requests WHERE version > synced_version LIMIT 1`)) times.push(Date.now() + SYNC_RETRY_MS);
    if (times.length > 0) await this.scheduleAlarm(Math.min(...times));
  }

  // Sets the alarm unless an earlier one is already pending.
  private async scheduleAlarm(at: number): Promise<void> {
    const desired = Math.max(at, Date.now() + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > desired) await this.ctx.storage.setAlarm(desired);
  }

  private createSchema(): void {
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
  }

  private exec(query: string, ...params: (string | number)[]): void {
    this.ctx.storage.sql.exec(query, ...params).toArray();
  }

  private all<T>(query: string, ...params: (string | number)[]): T[] {
    return this.ctx.storage.sql.exec(query, ...params).toArray() as T[];
  }

  private one<T>(query: string, ...params: (string | number)[]): T | null {
    return this.all<T>(query, ...params)[0] ?? null;
  }
}
