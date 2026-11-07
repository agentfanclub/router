import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { UsageSnapshot } from "../do/user-usage";
import { usageLimit, usageLog } from "../db/schema";
import { DEFAULT_FIVE_HOUR_LIMIT_MICRO, DEFAULT_WEEKLY_LIMIT_MICRO, type UsageLimits } from "../util/usage";
import { calendarDay, localDayStart, parseUtcOffsetMinutes } from "../util/timezone";
import { UserSession, userAuth } from "../middleware/user-auth";
import { WorkerEnv } from "../worker-env";

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

async function effectiveLimits(db: ReturnType<typeof drizzle>, userId: string): Promise<UsageLimits> {
  const [row] = await db
    .select({ fiveHourMicro: usageLimit.fiveHourMicro, weeklyMicro: usageLimit.weeklyMicro })
    .from(usageLimit)
    .where(eq(usageLimit.userId, userId))
    .limit(1);
  return {
    fiveHourMicro: row?.fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO,
    weeklyMicro: row?.weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO,
  };
}

export const usageRoutes = Layer.mergeAll(
  // Public allowance percentages and recorded token usage. Dollar limits stay internal.
  HttpRouter.add("GET", "/api/usage/me", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const offsetMinutes = parseUtcOffsetMinutes(new URL(request.url, env.BETTER_AUTH_URL).searchParams.get("tzOffset"));
    const db = drizzle(env.DB);

    const limits = yield* Effect.promise(() => effectiveLimits(db, session.user.id));
    const windows = yield* Effect.tryPromise(() => env.USER_USAGE.getByName(session.user.id).status(limits)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!windows) {
      return HttpServerResponse.jsonUnsafe({ error: "Unable to load usage right now." }, { status: 503 });
    }

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = localDayStart(now, offsetMinutes);
    // prompt_tokens already includes cached input. Count those tokens once.
    const totalTokens = sql`COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)`;
    const userFilter = eq(usageLog.userId, session.user.id);
    const [totals, history, perModel] = yield* Effect.promise(() => Promise.all([
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

  HttpRouter.add("GET", "/api/usage/sessions", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, env.BETTER_AUTH_URL);
    const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
    const model = url.searchParams.get("model");
    const filters = [eq(usageLog.userId, session.user.id)];
    if (model) filters.push(eq(usageLog.model, model));
    const db = drizzle(env.DB);
    const sessions = yield* Effect.promise(() => db.select({
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
  HttpRouter.add("GET", "/api/usage/logs", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const db = drizzle(env.DB);

    const url = new URL(request.url, env.BETTER_AUTH_URL);
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const sessionId = url.searchParams.get("session");
    const model = url.searchParams.get("model");

    const filters = [eq(usageLog.userId, session.user.id)];
    if (sessionId) filters.push(or(eq(usageLog.sessionId, sessionId), and(isNull(usageLog.sessionId), eq(usageLog.id, sessionId)))!);
    if (model) filters.push(eq(usageLog.model, model));

    const logs = yield* Effect.promise(() => db
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
      .limit(limit + 1).offset(offset),
    );

    return HttpServerResponse.jsonUnsafe({ logs: logs.slice(0, limit), nextOffset: logs.length > limit ? offset + limit : null } satisfies UsageLogFeed);
  })),
).pipe(Layer.provide(userAuth));
