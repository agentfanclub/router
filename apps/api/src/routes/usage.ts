import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { UsageSnapshot } from "../do/user-usage";
import { usageLimit, usageLog, usageTotal } from "../db/schema";
import { ApiError, decodeQuery } from "../http";
import { UserSession, userAuth } from "../middleware/user-auth";
import { query, UsageCoordinator } from "../services";
import { dailyUsage } from "../usage-aggregates";
import { addDays, centralDay, centralOffsetMinutes } from "../util/timezone";
import { DEFAULT_FIVE_HOUR_LIMIT_MICRO, DEFAULT_WEEKLY_LIMIT_MICRO, type UsageLimits } from "../util/usage";

export type UsageLogRow = Pick<
  typeof usageLog.$inferSelect,
  "id" | "sessionId" | "model" | "upstream" | "billed" | "inputTokens" | "outputTokens" | "cachedTokens" | "chargeMicro" | "estimated" | "status" | "durationMs" | "createdAt"
>;

export interface UsageStatus {
  fiveHour: { usedPercent: number; pendingPercent: number; resetsInMs: number };
  weekly: { usedPercent: number; pendingPercent: number; resetsInMs: number };
  // The 7 and 30 day figures are Central calendar days, including today.
  tokens: { lifetime: number; last24Hours: number; last7Days: number; last30Days: number };
  // Sparse daily model totals for the last 30 Central calendar days. The chart fills gaps.
  history: { day: string; model: string; tokens: number }[];
  // Over the last 30 Central days, and the last 7.
  perModel: { model: string; inputTokens: number; outputTokens: number; cachedTokens: number; chargeMicro: number; last7DaysTokens: number; last7DaysChargeMicro: number }[];
  // Central time's current UTC offset in minutes east, for laying out the chart's days.
  tzOffset: number;
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
    chargeMicro: number;
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

    const limits = yield* effectiveLimits(session.user.id);
    const windows = yield* usage.status(session.user.id, limits).pipe(
      Effect.mapError(() => new ApiError({ status: 503, message: "Unable to load usage right now." })),
    );

    const now = Date.now();
    const today = centralDay(now);
    const since7 = addDays(today, -6);
    // prompt_tokens already includes cached input. Count those tokens once.
    const [[lifetime], [recent], daily] = yield* query((db) => Promise.all([
      db.select({ tokens: sql<number>`COALESCE(SUM(${usageTotal.inputTokens} + ${usageTotal.outputTokens}), 0)` })
        .from(usageTotal).where(eq(usageTotal.userId, session.user.id)),
      db.select({ tokens: sql<number>`COALESCE(SUM(COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)), 0)` })
        .from(usageLog).where(and(eq(usageLog.userId, session.user.id), gte(usageLog.createdAt, new Date(now - 24 * 60 * 60 * 1000)))),
      dailyUsage(db.$client, { since: addDays(today, -29), userId: session.user.id }),
    ]));

    const tokens = { lifetime: lifetime!.tokens, last24Hours: recent!.tokens, last7Days: 0, last30Days: 0 };
    const history = new Map<string, UsageStatus["history"][number]>();
    const perModel = new Map<string, UsageStatus["perModel"][number]>();
    for (const row of daily) {
      const rowTokens = row.inputTokens + row.outputTokens;
      const charge = row.clubChargeMicro + row.personalChargeMicro;
      const inLast7 = row.day >= since7;
      tokens.last30Days += rowTokens;
      if (inLast7) tokens.last7Days += rowTokens;
      const key = `${row.day}\u0000${row.model}`;
      const point = history.get(key) ?? { day: row.day, model: row.model, tokens: 0 };
      point.tokens += rowTokens;
      history.set(key, point);
      const model = perModel.get(row.model) ?? { model: row.model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, chargeMicro: 0, last7DaysTokens: 0, last7DaysChargeMicro: 0 };
      model.inputTokens += row.inputTokens;
      model.outputTokens += row.outputTokens;
      model.cachedTokens += row.cachedTokens;
      model.chargeMicro += charge;
      if (inLast7) {
        model.last7DaysTokens += rowTokens;
        model.last7DaysChargeMicro += charge;
      }
      perModel.set(row.model, model);
    }

    const publicWindow = (window: UsageSnapshot["fiveHour"]) => ({
      usedPercent: window.limitMicro > 0 ? window.usedMicro / window.limitMicro * 100 : 100,
      pendingPercent: window.limitMicro > 0 ? windows.pendingMicro / window.limitMicro * 100 : 0,
      resetsInMs: window.resetsInMs,
    });
    return HttpServerResponse.jsonUnsafe({
      fiveHour: publicWindow(windows.fiveHour),
      weekly: publicWindow(windows.weekly),
      tokens,
      history: [...history.values()],
      perModel: [...perModel.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
      tzOffset: centralOffsetMinutes(now),
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
      chargeMicro: sql<number>`SUM(${usageLog.chargeMicro})`,
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
        chargeMicro: usageLog.chargeMicro,
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
