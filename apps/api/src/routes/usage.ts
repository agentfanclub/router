import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { UsageSnapshot } from "../do/user-usage";
import { usageLimit, usageLog } from "../db/schema";
import { ApiError, decodeQuery } from "../http";
import { UserSession, userAuth } from "../middleware/user-auth";
import { query, UsageCoordinator } from "../services";
import { calendarDay, localDayStart, parseUtcOffsetMinutes } from "../util/timezone";
import { DEFAULT_FIVE_HOUR_LIMIT_MICRO, DEFAULT_WEEKLY_LIMIT_MICRO, type UsageLimits } from "../util/usage";

export type UsageLogRow = Pick<
  typeof usageLog.$inferSelect,
  "id" | "sessionId" | "model" | "upstream" | "billed" | "inputTokens" | "outputTokens" | "cachedTokens" | "costMicro" | "estimated" | "status" | "durationMs" | "createdAt"
>;

export interface UsageStatus {
  fiveHour: { usedPercent: number; pendingPercent: number; resetsInMs: number };
  weekly: { usedPercent: number; pendingPercent: number; resetsInMs: number };
  tokens: { lifetime: number; last24Hours: number; last7Days: number; last30Days: number };
  // Sparse daily model totals for the last 30 UTC dates. The chart fills gaps.
  history: { day: string; model: string; tokens: number }[];
  perModel: { model: string; inputTokens: number; outputTokens: number; cachedTokens: number; costMicro: number; last7DaysTokens: number; last7DaysCostMicro: number }[];
}

export interface UsageLogFeed {
  logs: UsageLogRow[];
  nextOffset: number | null;
}

export interface UsageSessionFeed {
  sessions: {
    id: string;
    sessionId: string | null;
    requests: number;
    models: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    durationMs: number;
    costMicro: number;
    estimated: number;
    errors: number;
    pending: number;
    firstAt: string;
    lastAt: string;
  }[];
  hasMore: boolean;
}

const effectiveLimits = (userId: string) => query((db) => db
  .select({ fiveHourMicro: usageLimit.fiveHourMicro, weeklyMicro: usageLimit.weeklyMicro })
  .from(usageLimit)
  .where(eq(usageLimit.userId, userId))
  .limit(1)).pipe(Effect.map(([row]): UsageLimits => ({
    fiveHourMicro: row?.fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO,
    weeklyMicro: row?.weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO,
  })));

// Paging is lenient: unparseable numbers fall back to the default.
const OptionalString = Schema.optional(Schema.String);
const toInt = (raw: string | undefined, fallback: number) => {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

const MeQuery = Schema.Struct({ tzOffset: Schema.optional(Schema.String) });
const SessionsQuery = Schema.Struct({ page: OptionalString, model: Schema.optional(Schema.String) });
const LogsQuery = Schema.Struct({
  limit: OptionalString,
  offset: OptionalString,
  session: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

export const usageRoutes = Layer.mergeAll(
  // Public allowance percentages and recorded token usage. Dollar limits stay internal.
  HttpRouter.add("GET", "/api/usage/me", Effect.fn("myUsage")(function* () {
    const session = yield* UserSession;
    const usage = yield* UsageCoordinator;
    const { tzOffset } = yield* decodeQuery(MeQuery);
    const offsetMinutes = parseUtcOffsetMinutes(tzOffset ?? null);

    const limits = yield* effectiveLimits(session.user.id);
    const windows = yield* usage.status(session.user.id, limits).pipe(
      Effect.mapError(() => new ApiError({ status: 503, message: "Unable to load usage right now." })),
    );

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = localDayStart(now, offsetMinutes);
    // prompt_tokens already includes cached input. Count those tokens once.
    const totalTokens = sql`COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)`;
    const userFilter = eq(usageLog.userId, session.user.id);
    const [totals, history, perModel] = yield* query((db) => Promise.all([
      db.select({
        lifetime: sql<number>`COALESCE(SUM(${totalTokens}), 0)`,
        last24Hours: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.createdAt} >= ${now - dayMs} THEN ${totalTokens} ELSE 0 END), 0)`,
        last7Days: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.createdAt} >= ${now - 7 * dayMs} THEN ${totalTokens} ELSE 0 END), 0)`,
        last30Days: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.createdAt} >= ${now - 30 * dayMs} THEN ${totalTokens} ELSE 0 END), 0)`,
      }).from(usageLog).where(userFilter),
      db.select({
        day: calendarDay(usageLog.createdAt, offsetMinutes),
        model: usageLog.model,
        tokens: sql<number>`COALESCE(SUM(${totalTokens}), 0)`,
      }).from(usageLog)
        .where(and(userFilter, gte(usageLog.createdAt, new Date(dayStart - 29 * dayMs))))
        .groupBy(sql`1`, usageLog.model).orderBy(sql`1`, usageLog.model),
      db.select({
        model: usageLog.model,
        inputTokens: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        cachedTokens: sql<number>`COALESCE(SUM(${usageLog.cachedTokens}), 0)`,
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
        last7DaysTokens: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.createdAt} >= ${now - 7 * dayMs} THEN ${totalTokens} ELSE 0 END), 0)`,
        last7DaysCostMicro: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.createdAt} >= ${now - 7 * dayMs} THEN ${usageLog.costMicro} ELSE 0 END), 0)`,
      }).from(usageLog)
        .where(and(userFilter, gte(usageLog.createdAt, new Date(now - 30 * dayMs))))
        .groupBy(usageLog.model).orderBy(desc(sql`SUM(${totalTokens})`)),
    ]));
    const publicWindow = (window: UsageSnapshot["fiveHour"]) => ({
      usedPercent: window.limitMicro > 0 ? window.usedMicro / window.limitMicro * 100 : 100,
      pendingPercent: window.limitMicro > 0 ? windows.pendingMicro / window.limitMicro * 100 : 0,
      resetsInMs: window.resetsInMs,
    });
    return HttpServerResponse.jsonUnsafe({
      fiveHour: publicWindow(windows.fiveHour),
      weekly: publicWindow(windows.weekly),
      tokens: totals[0], history, perModel,
    } satisfies UsageStatus);
  })),

  HttpRouter.add("GET", "/api/usage/sessions", Effect.fn("usageSessions")(function* () {
    const session = yield* UserSession;
    const params = yield* decodeQuery(SessionsQuery);
    const page = Math.max(0, toInt(params.page, 0));
    const filters = [eq(usageLog.userId, session.user.id)];
    if (params.model) filters.push(eq(usageLog.model, params.model));
    const sessions = yield* query((db) => db.select({
      id: sql<string>`COALESCE(${usageLog.sessionId}, ${usageLog.id})`,
      sessionId: usageLog.sessionId,
      requests: sql<number>`COUNT(*)`,
      models: sql<string>`GROUP_CONCAT(DISTINCT ${usageLog.model})`,
      inputTokens: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
      cachedTokens: sql<number>`COALESCE(SUM(${usageLog.cachedTokens}), 0)`,
      durationMs: sql<number>`COALESCE(SUM(${usageLog.durationMs}), 0)`,
      costMicro: sql<number>`SUM(${usageLog.costMicro})`,
      estimated: sql<number>`MAX(${usageLog.estimated})`,
      errors: sql<number>`SUM(CASE WHEN ${usageLog.status} IN ('error', 'aborted', 'denied') THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN ${usageLog.status} = 'pending' THEN 1 ELSE 0 END)`,
      firstAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', MIN(${usageLog.createdAt}) / 1000.0, 'unixepoch')`,
      lastAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', MAX(${usageLog.createdAt}) / 1000.0, 'unixepoch')`,
    }).from(usageLog).where(and(...filters))
      .groupBy(sql`COALESCE(${usageLog.sessionId}, ${usageLog.id})`)
      .orderBy(desc(sql`MAX(${usageLog.createdAt})`), sql`COALESCE(${usageLog.sessionId}, ${usageLog.id})`)
      .limit(101).offset(page * 100));
    return HttpServerResponse.jsonUnsafe({ sessions: sessions.slice(0, 100), hasMore: sessions.length > 100 } satisfies UsageSessionFeed);
  })),

  // Recent request history for the logs page. Optional session and model
  // filters narrow the feed.
  HttpRouter.add("GET", "/api/usage/logs", Effect.fn("usageLogs")(function* () {
    const session = yield* UserSession;
    const params = yield* decodeQuery(LogsQuery);
    const limit = Math.min(Math.max(toInt(params.limit, 100), 1), 500);
    const offset = Math.max(0, toInt(params.offset, 0));
    const { session: sessionId, model } = params;

    const filters = [eq(usageLog.userId, session.user.id)];
    if (sessionId) filters.push(or(eq(usageLog.sessionId, sessionId), and(isNull(usageLog.sessionId), eq(usageLog.id, sessionId)))!);
    if (model) filters.push(eq(usageLog.model, model));

    const logs = yield* query((db) => db
      .select({
        id: usageLog.id,
        sessionId: usageLog.sessionId,
        model: usageLog.model,
        upstream: usageLog.upstream,
        billed: usageLog.billed,
        inputTokens: usageLog.inputTokens,
        outputTokens: usageLog.outputTokens,
        cachedTokens: usageLog.cachedTokens,
        costMicro: usageLog.costMicro,
        estimated: usageLog.estimated,
        status: usageLog.status,
        durationMs: usageLog.durationMs,
        createdAt: usageLog.createdAt,
      })
      .from(usageLog)
      .where(and(...filters))
      .orderBy(desc(usageLog.createdAt), desc(usageLog.id))
      .limit(limit + 1).offset(offset));

    return HttpServerResponse.jsonUnsafe({ logs: logs.slice(0, limit), nextOffset: logs.length > limit ? offset + limit : null } satisfies UsageLogFeed);
  })),
).pipe(Layer.provide(userAuth));
