import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { user, usageLimit, usageLog, usageTotal } from "../db/schema";
import { ApiError, decodeBody, decodeQuery, failWith } from "../http";
import { UserSession, userAuthMiddleware } from "../middleware/user-auth";
import { query, WorkerEnv } from "../services";
import { upstreamKeys } from "../upstreams";
import { addDays, centralDay, centralDaySql, centralDayStart, centralOffsetMinutes } from "../util/timezone";

export type User = Pick<typeof user.$inferSelect, "id" | "name" | "email" | "role"> & {
  fiveHourMicro: number | null;
  weeklyMicro: number | null;
};

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
  perUser: { userId: string; name: string; email: string; clubChargeMicro: number; personalChargeMicro: number; costMicro: number; sessions: number }[];
  // Club billing only.
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
    const users = yield* query((db) => db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        fiveHourMicro: usageLimit.fiveHourMicro,
        weeklyMicro: usageLimit.weeklyMicro,
      })
      .from(user)
      .leftJoin(usageLimit, eq(usageLimit.userId, user.id))
      .orderBy(asc(user.email)));
    return HttpServerResponse.jsonUnsafe(users satisfies User[]);
  })),

  // Cross-user usage from the logs, powering the admin graphs. The `days`
  // query parameter selects the last 7 or 30 Central days.
  HttpRouter.add("GET", "/api/admin/usage", Effect.fn("adminUsage")(function* () {
    const params = yield* decodeQuery(UsageQuery);
    const days = params.days === "7" ? 7 : 30;
    const now = Date.now();
    const since = new Date(centralDayStart(addDays(centralDay(now), -(days - 1))));
    const inRange = gte(usageLog.createdAt, since);
    const charge = (billed: "club" | "personal") => sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.billed} = ${billed} THEN ${usageLog.chargeMicro} ELSE 0 END), 0)`;

    const [perUser, perModel, history] = yield* query((db) => Promise.all([
      db.select({
        userId: usageLog.userId,
        name: user.name,
        email: user.email,
        clubChargeMicro: charge("club"),
        personalChargeMicro: charge("personal"),
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
        sessions: sql<number>`COUNT(DISTINCT ${usageLog.sessionId})`,
      })
        .from(usageLog)
        .innerJoin(user, eq(user.id, usageLog.userId))
        .where(inRange)
        .groupBy(usageLog.userId, user.name, user.email)
        .orderBy(desc(charge("club"))),
      // Club billing only.
      db.select({
        model: usageLog.model,
        requests: sql<number>`COUNT(*)`,
        inputTokens: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        chargeMicro: sql<number>`COALESCE(SUM(${usageLog.chargeMicro}), 0)`,
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
      })
        .from(usageLog)
        .where(and(inRange, eq(usageLog.billed, "club")))
        .groupBy(usageLog.model)
        .orderBy(desc(sql`SUM(${usageLog.chargeMicro})`)),
      // Every user and key. Input tokens already include cached tokens.
      db.select({
        day: centralDaySql(usageLog.createdAt),
        model: usageLog.model,
        tokens: sql<number>`COALESCE(SUM(COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)), 0)`,
        chargeMicro: sql<number>`COALESCE(SUM(${usageLog.chargeMicro}), 0)`,
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
      })
        .from(usageLog)
        .where(inRange)
        .groupBy(sql`1`, usageLog.model)
        .orderBy(sql`1`, usageLog.model),
    ]));

    return HttpServerResponse.jsonUnsafe({ days, perUser, perModel, history, tzOffset: centralOffsetMinutes(now) } satisfies AdminUsage);
  })),

  // Token leaderboard: lifetime (or windowed) token totals per user, ranked
  // highest first. A `days` of 7 or 30 narrows the window to that many
  // Central days; anything else means lifetime. Prompt tokens already include
  // cached input, so they count once.
  HttpRouter.add("GET", "/api/admin/token-leaderboard", Effect.fn("tokenLeaderboard")(function* () {
    const { days: range } = yield* decodeQuery(UsageQuery);
    const days = range === "7" ? 7 : range === "30" ? 30 : null;

    const entries = yield* query((db) => {
      if (days === null) {
        const totalTokens = sql<number>`SUM(${usageTotal.inputTokens} + ${usageTotal.outputTokens})`;
        return db.select({
          userId: user.id,
          name: user.name,
          email: user.email,
          inputTokens: sql<number>`SUM(${usageTotal.inputTokens})`,
          outputTokens: sql<number>`SUM(${usageTotal.outputTokens})`,
          totalTokens,
          requests: sql<number>`SUM(${usageTotal.requests})`,
          sessions: sql<number>`SUM(${usageTotal.sessions})`,
        })
          .from(usageTotal)
          .innerJoin(user, eq(user.id, usageTotal.userId))
          .groupBy(user.id, user.name, user.email)
          .orderBy(desc(totalTokens), asc(user.email))
          .limit(100);
      }
      const since = new Date(centralDayStart(addDays(centralDay(Date.now()), -(days - 1))));
      const totalTokens = sql<number>`COALESCE(SUM(COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)), 0)`;
      return db.select({
        userId: user.id,
        name: user.name,
        email: user.email,
        inputTokens: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        totalTokens,
        requests: sql<number>`COUNT(*)`,
        sessions: sql<number>`COUNT(DISTINCT ${usageLog.sessionId})`,
      })
        .from(usageLog)
        .innerJoin(user, eq(user.id, usageLog.userId))
        .where(gte(usageLog.createdAt, since))
        .groupBy(user.id, user.name, user.email)
        .orderBy(desc(totalTokens), asc(user.email))
        .limit(100);
    });

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
