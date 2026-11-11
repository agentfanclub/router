import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { user, usageLimit, usageTotal } from "../db/schema";
import { ApiError, decodeBody, decodeQuery, failWith } from "../http";
import { UserSession, userAuthMiddleware } from "../middleware/user-auth";
import { query, WorkerEnv } from "../services";
import { upstreamKeys } from "../upstreams";
import { dailyUsage } from "../usage-aggregates";
import { addDays, centralDay, centralOffsetMinutes } from "../util/timezone";

export interface LifetimeUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  clubChargeMicro: number;
  personalChargeMicro: number;
  costMicro: number;
  sessions: number;
}

export type AdminUser = Pick<typeof user.$inferSelect, "id" | "name" | "email" | "role"> & LifetimeUsage & {
  fiveHourMicro: number | null;
  weeklyMicro: number | null;
};

export interface AdminUsers {
  users: AdminUser[];
  page: number;
  hasMore: boolean;
}

export const ADMIN_PAGE_SIZE = 20;

// Lifetime reads use the compact totals, never request logs. Cached input is
// already included in input_tokens and must not be added again.
export async function lifetimeUsage(d1: D1Database): Promise<LifetimeUsage> {
  const { results } = await d1.prepare(`
    SELECT COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
      COALESCE(SUM(club_charge_micro), 0) AS clubChargeMicro,
      COALESCE(SUM(personal_charge_micro), 0) AS personalChargeMicro,
      COALESCE(SUM(cost_micro), 0) AS costMicro,
      COALESCE(SUM(sessions), 0) AS sessions
    FROM usage_total
  `).all<LifetimeUsage>();
  return results[0]!;
}

// Rank IDs before loading user profiles and limits, so only this page needs
// those rows. Include accounts without usage after the active users.
export async function adminUsers(d1: D1Database, page: number): Promise<AdminUsers> {
  const { results } = await d1.prepare(`
    WITH totals AS (
      SELECT user_id, SUM(requests) AS requests, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, SUM(input_tokens + output_tokens) AS totalTokens,
        SUM(club_charge_micro) AS clubChargeMicro, SUM(personal_charge_micro) AS personalChargeMicro,
        SUM(cost_micro) AS costMicro, SUM(sessions) AS sessions
      FROM usage_total GROUP BY user_id
    ), ranked AS (
      SELECT * FROM totals
      UNION ALL
      SELECT u.id, 0, 0, 0, 0, 0, 0, 0, 0
      FROM user u WHERE NOT EXISTS (SELECT 1 FROM usage_total t WHERE t.user_id = u.id)
      ORDER BY totalTokens DESC, user_id ASC
      LIMIT ?1 OFFSET ?2
    )
    SELECT u.id, u.name, u.email, u.role,
      ranked.requests, ranked.inputTokens, ranked.outputTokens, ranked.totalTokens,
      ranked.clubChargeMicro, ranked.personalChargeMicro, ranked.costMicro, ranked.sessions,
      l.five_hour_micro AS fiveHourMicro, l.weekly_micro AS weeklyMicro
    FROM ranked
    JOIN user u ON u.id = ranked.user_id
    LEFT JOIN usage_limit l ON l.user_id = ranked.user_id
    ORDER BY ranked.totalTokens DESC, ranked.user_id ASC
  `).bind(ADMIN_PAGE_SIZE + 1, page * ADMIN_PAGE_SIZE).all<AdminUser>();
  return { users: results.slice(0, ADMIN_PAGE_SIZE), page, hasMore: results.length > ADMIN_PAGE_SIZE };
}

export interface TokenLeaderboard {
  days: number;
  // Ranked by total tokens, descending.
  entries: {
    userId: string;
    name: string;
    email: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
    sessions: number;
  }[];
  totals: { totalTokens: number; users: number };
}

// `chargeMicro` is what users were charged at router prices. `costMicro` is
// what upstreams charged the club. Days are Central calendar days.
export interface AdminUsage {
  days: number;
  perModel: { model: string; requests: number; inputTokens: number; outputTokens: number; chargeMicro: number; costMicro: number }[];
  history: { day: string; model: string; tokens: number; chargeMicro: number; costMicro: number }[];
  // Central time's current UTC offset in minutes east, for laying out the chart's days.
  tzOffset: number;
}

const adminAuth = HttpRouter.middleware()((handler) => Effect.gen(function* () {
  const session = yield* UserSession;
  if (session.user.role !== "admin") return yield* failWith(403, "Forbidden");
  return yield* handler;
})).combine(userAuthMiddleware).layer;

const lumenUsageSchema = Schema.Struct({
  requests: Schema.Number,
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  total_tokens: Schema.Number,
  audio_seconds: Schema.Number,
  cost: Schema.Number,
  coins_available: Schema.NullOr(Schema.Number),
  last_used_at: Schema.NullOr(Schema.String),
});

export type LumenUsage = typeof lumenUsageSchema.Type;

const UsageQuery = Schema.Struct({ days: Schema.optional(Schema.String) });

// Null restores the default. Limits are whole micro-dollars up to $1M.
const Limit = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000_000_000)));
const LimitsBody = Schema.Struct({ fiveHourMicro: Limit, weeklyMicro: Limit });

export const adminRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/admin/users", Effect.fn("listUsers")(function* () {
    const params = yield* decodeQuery(Schema.Struct({ page: Schema.optional(Schema.String) }));
    const value = Number(params.page ?? 0);
    const page = Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
    const result = yield* query((db) => adminUsers(db.$client, page));
    return HttpServerResponse.jsonUnsafe(result);
  })),

  HttpRouter.add("GET", "/api/admin/lifetime-usage", Effect.fn("adminLifetimeUsage")(function* () {
    const result = yield* query((db) => lifetimeUsage(db.$client));
    return HttpServerResponse.jsonUnsafe(result);
  })),

  // Cross-user usage over the last 7 or 30 Central days, powering the admin
  // graphs. One read of the daily totals feeds every breakdown.
  HttpRouter.add("GET", "/api/admin/usage", Effect.fn("adminUsage")(function* () {
    const params = yield* decodeQuery(UsageQuery);
    const days = params.days === "7" ? 7 : 30;
    const now = Date.now();
    const rows = yield* query((db) => dailyUsage(db.$client, { since: addDays(centralDay(now), -(days - 1)) }));

    const perModel = new Map<string, AdminUsage["perModel"][number]>();
    const history = new Map<string, AdminUsage["history"][number]>();
    for (const row of rows) {
      const charge = row.clubChargeMicro + row.personalChargeMicro;
      const model = perModel.get(row.model) ?? { model: row.model, requests: 0, inputTokens: 0, outputTokens: 0, chargeMicro: 0, costMicro: 0 };
      model.requests += row.requests;
      model.inputTokens += row.inputTokens;
      model.outputTokens += row.outputTokens;
      model.chargeMicro += charge;
      model.costMicro += row.costMicro;
      perModel.set(row.model, model);
      // Input tokens already include cached tokens.
      const key = `${row.day}\u0000${row.model}`;
      const point = history.get(key) ?? { day: row.day, model: row.model, tokens: 0, chargeMicro: 0, costMicro: 0 };
      point.tokens += row.inputTokens + row.outputTokens;
      point.chargeMicro += charge;
      point.costMicro += row.costMicro;
      history.set(key, point);
    }

    return HttpServerResponse.jsonUnsafe({
      days,
      perModel: [...perModel.values()].sort((a, b) => b.chargeMicro - a.chargeMicro),
      history: [...history.values()],
      tzOffset: centralOffsetMinutes(now),
    } satisfies AdminUsage);
  })),

  // Token leaderboard: lifetime (or windowed) token totals per user, ranked
  // highest first. A `days` of 7 or 30 narrows the window to that many
  // Central days; anything else means lifetime. Prompt tokens already include
  // cached input, so they count once.
  HttpRouter.add("GET", "/api/admin/token-leaderboard", Effect.fn("tokenLeaderboard")(function* () {
    const { days: range } = yield* decodeQuery(UsageQuery);
    const days = range === "7" ? 7 : range === "30" ? 30 : null;

    const [rows, users] = yield* query((db) => Promise.all([
      days === null
        ? db.select().from(usageTotal)
        : dailyUsage(db.$client, { since: addDays(centralDay(Date.now()), -(days - 1)) }),
      db.select({ id: user.id, name: user.name, email: user.email }).from(user),
    ]));
    const userById = new Map(users.map((row) => [row.id, row]));
    const byUser = new Map<string, TokenLeaderboard["entries"][number]>();
    for (const row of rows) {
      const account = userById.get(row.userId);
      if (!account) continue;
      const entry = byUser.get(row.userId) ?? { userId: row.userId, name: account.name, email: account.email, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, sessions: 0 };
      entry.inputTokens += row.inputTokens;
      entry.outputTokens += row.outputTokens;
      entry.totalTokens += row.inputTokens + row.outputTokens;
      entry.requests += row.requests;
      entry.sessions += row.sessions;
      byUser.set(row.userId, entry);
    }
    const entries = [...byUser.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email))
      .slice(0, 100);

    return HttpServerResponse.jsonUnsafe({
      days: days ?? 0,
      entries,
      totals: {
        totalTokens: entries.reduce((sum, entry) => sum + entry.totalTokens, 0),
        users: entries.length,
      },
    } satisfies TokenLeaderboard);
  })),

  // Set per-user cap overrides. Null columns fall back to the defaults.
  HttpRouter.add("PUT", "/api/admin/users/:id/limits", Effect.fn("setUserLimits")(function* () {
    const { id } = yield* HttpRouter.params;
    const { fiveHourMicro, weeklyMicro } = yield* decodeBody(
      LimitsBody,
      "Limits must be positive whole micro-dollars, or null to use the defaults.",
    );
    const [exists] = yield* query((db) => db.select({ id: user.id }).from(user).where(eq(user.id, id!)).limit(1));
    if (!exists) return yield* failWith(404, "User not found.");

    const [updated] = yield* query((db) => db
      .insert(usageLimit)
      .values({ userId: id!, fiveHourMicro, weeklyMicro })
      .onConflictDoUpdate({ target: usageLimit.userId, set: { fiveHourMicro, weeklyMicro } })
      .returning({ userId: usageLimit.userId, fiveHourMicro: usageLimit.fiveHourMicro, weeklyMicro: usageLimit.weeklyMicro }));
    return HttpServerResponse.jsonUnsafe(updated);
  })),

  HttpRouter.add("GET", "/api/admin/lumen-usage", Effect.fn("lumenUsage")(function* () {
    const env = yield* WorkerEnv;
    // Reports the account behind the first configured key.
    const [key] = upstreamKeys(env, "lumen");
    if (!key) return yield* failWith(503, "Lumen API key is not configured.");

    const response = yield* Effect.tryPromise(() => fetch("https://lumen.ncsa.illinois.edu/v1/usage", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    })).pipe(Effect.orElseSucceed(() => null));
    if (!response) return yield* failWith(502, "Unable to reach Lumen usage.");
    if (!response.ok) return yield* failWith(502, `Lumen usage request failed with HTTP ${response.status}.`);

    const usage = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(lumenUsageSchema)),
      Effect.mapError(() => new ApiError({ status: 502, message: "Lumen returned an invalid usage response." })),
    );
    // Lumen can append Z to a timestamp that already has a UTC offset.
    return HttpServerResponse.jsonUnsafe({
      ...usage,
      last_used_at: usage.last_used_at?.replace(/\+00:00Z$/, "Z") ?? null,
    } satisfies LumenUsage);
  })),
).pipe(Layer.provide(adminAuth));
