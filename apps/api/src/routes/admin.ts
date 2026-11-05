import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { user, usageLimit, usageLog } from "../db/schema";
import { UserSession, userAuthMiddleware } from "../middleware/user-auth";
import { calendarDay, localDayStart, parseUtcOffsetMinutes } from "../util/timezone";
import { WorkerEnv } from "../worker-env";

export type User = Pick<typeof user.$inferSelect, "id" | "name" | "email" | "role"> & {
  fiveHourMicro: number | null;
  weeklyMicro: number | null;
};

export interface AdminUsage {
  days: number;
  perUser: { userId: string; name: string; email: string; clubMicro: number; personalMicro: number; sessions: number }[];
  perModel: { model: string; costMicro: number; requests: number; inputTokens: number; outputTokens: number }[];
  history: { day: string; model: string; tokens: number; costMicro: number }[];
}

const adminAuth = HttpRouter.middleware()((handler) => Effect.gen(function* () {
  const session = yield* UserSession;
  if (session.user.role !== "admin") {
    return HttpServerResponse.jsonUnsafe({ error: "Forbidden" }, { status: 403 });
  }
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

export const adminRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/admin/users", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const users = yield* Effect.promise(() => drizzle(env.DB)
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
      .orderBy(asc(user.email)),
    );

    return HttpServerResponse.jsonUnsafe(users satisfies User[]);
  })),

  // Cross-user spend aggregates from the usage log, powering the admin
  // graphs. The `days` query parameter selects a 7 or 30 day window.
  HttpRouter.add("GET", "/api/admin/usage", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const db = drizzle(env.DB);

    const url = new URL(request.url, env.BETTER_AUTH_URL);
    const days = url.searchParams.get("days") === "30" ? 30 : 7;
    const offsetMinutes = parseUtcOffsetMinutes(url.searchParams.get("tzOffset"));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // The model spend table tracks club billing. The token chart includes all users and keys.
    const inRange = and(gte(usageLog.createdAt, since), eq(usageLog.billed, "club"));

    const [perUser, perModel, history] = yield* Effect.promise(() => Promise.all([
      db.select({
        userId: usageLog.userId,
        name: user.name,
        email: user.email,
        clubMicro: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.billed} = 'club' THEN ${usageLog.costMicro} ELSE 0 END), 0)`,
        personalMicro: sql<number>`COALESCE(SUM(CASE WHEN ${usageLog.billed} = 'personal' THEN ${usageLog.costMicro} ELSE 0 END), 0)`,
        sessions: sql<number>`COUNT(DISTINCT ${usageLog.sessionId})`,
      })
        .from(usageLog)
        .innerJoin(user, eq(user.id, usageLog.userId))
        .where(and(gte(usageLog.createdAt, since)))
        .groupBy(usageLog.userId, user.name, user.email)
        .orderBy(desc(sql`COALESCE(SUM(CASE WHEN ${usageLog.billed} = 'club' THEN ${usageLog.costMicro} ELSE 0 END), 0)`)),
      db.select({
        model: usageLog.model,
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
        requests: sql<number>`COUNT(*)`,
        inputTokens: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
      })
        .from(usageLog)
        .where(inRange)
        .groupBy(usageLog.model)
        .orderBy(desc(sql`COALESCE(SUM(${usageLog.costMicro}), 0)`)),
      db.select({
        day: calendarDay(usageLog.createdAt, offsetMinutes),
        model: usageLog.model,
        // Input tokens already include cached tokens.
        tokens: sql<number>`COALESCE(SUM(COALESCE(${usageLog.inputTokens}, 0) + COALESCE(${usageLog.outputTokens}, 0)), 0)`,
        costMicro: sql<number>`COALESCE(SUM(${usageLog.costMicro}), 0)`,
      })
        .from(usageLog)
        .where(gte(usageLog.createdAt, new Date(localDayStart(Date.now(), offsetMinutes) - (days - 1) * 86400000)))
        .groupBy(sql`1`, usageLog.model)
        .orderBy(sql`1`, usageLog.model),
    ]));

    return HttpServerResponse.jsonUnsafe({ days, perUser, perModel, history } satisfies AdminUsage);
  })),

  // Set per-user cap overrides. Null columns fall back to the defaults.
  HttpRouter.add("PUT", "/api/admin/users/:id/limits", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const { id } = yield* HttpRouter.params;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));

    const db = drizzle(env.DB);
    const [exists] = yield* Effect.promise(() => db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, id!))
      .limit(1),
    );
    if (!exists) {
      return HttpServerResponse.jsonUnsafe({ error: "User not found." }, { status: 404 });
    }

    const parseLimit = (value: unknown): number | null | undefined => {
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 1_000_000_000_000) {
        return undefined;
      }
      return value;
    };
    const fiveHourMicro = parseLimit((body as Record<string, unknown> | null)?.fiveHourMicro);
    const weeklyMicro = parseLimit((body as Record<string, unknown> | null)?.weeklyMicro);
    if (fiveHourMicro === undefined || weeklyMicro === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Limits must be positive whole micro-dollars, or null to use the defaults." },
        { status: 400 },
      );
    }

    const [updated] = yield* Effect.promise(() => db
      .insert(usageLimit)
      .values({ userId: id!, fiveHourMicro, weeklyMicro })
      .onConflictDoUpdate({
        target: usageLimit.userId,
        set: { fiveHourMicro, weeklyMicro },
      })
      .returning({ userId: usageLimit.userId, fiveHourMicro: usageLimit.fiveHourMicro, weeklyMicro: usageLimit.weeklyMicro }),
    );

    return HttpServerResponse.jsonUnsafe(updated);
  })),

  HttpRouter.add("GET", "/api/admin/lumen-usage", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    if (!env.LUMEN_API_KEY) {
      return HttpServerResponse.jsonUnsafe({ error: "Lumen API key is not configured." }, { status: 503 });
    }

    const response = yield* Effect.tryPromise(() => fetch("https://lumen.ncsa.illinois.edu/v1/usage", {
      headers: { authorization: `Bearer ${env.LUMEN_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    })).pipe(Effect.orElseSucceed(() => null));

    if (!response) {
      return HttpServerResponse.jsonUnsafe({ error: "Unable to reach Lumen usage." }, { status: 502 });
    }

    if (!response.ok) {
      return HttpServerResponse.jsonUnsafe({
        error: `Lumen usage request failed with HTTP ${response.status}.`,
      }, { status: 502 });
    }

    return yield* Effect.tryPromise(async () => {
      const usage = Schema.decodeUnknownSync(lumenUsageSchema)(await response.json());
      // Lumen can append Z to a timestamp that already has a UTC offset.
      return HttpServerResponse.jsonUnsafe({
        ...usage,
        last_used_at: usage.last_used_at?.replace(/\+00:00Z$/, "Z") ?? null,
      });
    }).pipe(

      Effect.orElseSucceed(() => HttpServerResponse.jsonUnsafe(
        { error: "Lumen returned an invalid usage response." }, { status: 502 },
      )),
    );
  })),
).pipe(Layer.provide(adminAuth));
