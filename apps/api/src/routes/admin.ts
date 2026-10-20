import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { user } from "../db/schema";
import { UserSession, userAuth } from "../middleware/user-auth";
import { WorkerEnv } from "../worker-env";

export type User = Pick<typeof user.$inferSelect, "id" | "name" | "email" | "role">;

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
    const session = yield* UserSession;
    if (session.user.role !== "admin") {
      return HttpServerResponse.jsonUnsafe({ error: "Forbidden" }, { status: 403 });
    }
    const env = yield* WorkerEnv;
    const users = yield* Effect.promise(() => drizzle(env.DB)
      .select({ id: user.id, name: user.name, email: user.email, role: user.role })
      .from(user)
      .orderBy(asc(user.email)),
    );
    return HttpServerResponse.jsonUnsafe(users);
  })),
  HttpRouter.add("GET", "/api/admin/lumen-usage", Effect.gen(function* () {
    const session = yield* UserSession;
    if (session.user.role !== "admin") {
      return HttpServerResponse.jsonUnsafe({ error: "Forbidden" }, { status: 403 });
    }
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
).pipe(Layer.provide(userAuth));
