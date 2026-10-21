import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { apiKey } from "../db/schema";
import { createApiKey, publicApiKeyFields } from "../util/keys";
import { WorkerEnv } from "../worker-env";
import { UserSession, userAuth } from "../middleware/user-auth";

export type ApiKey = Pick<typeof apiKey.$inferSelect, "id" | "name" | "lastFive" | "enabled"> & {
  createdAt: string;
};

export const apiKeyRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/keys", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const db = drizzle(env.DB);
    const keys = yield* Effect.promise(() => db
      .select(publicApiKeyFields)
      .from(apiKey)
      .where(eq(apiKey.userId, session.user.id))
      .orderBy(desc(apiKey.createdAt)),
    );
    return HttpServerResponse.jsonUnsafe(keys);
  })),

  HttpRouter.add("POST", "/api/keys", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));

    if (
      !body || typeof body !== "object" ||
      !("name" in body) || typeof body.name !== "string"
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Enter a key name between 1 and 80 characters." },
        { status: 400 },
      );
    }

    const name = body.name.trim();
    if (name.length === 0 || name.length > 80) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Enter a key name between 1 and 80 characters." },
        { status: 400 },
      );
    }

    const { key, token } = yield* Effect.promise(() => createApiKey({
      db: drizzle(env.DB),
      userId: session.user.id,
      name,
    }));
    return HttpServerResponse.jsonUnsafe({ key, token }, { status: 201 });
  })),

  HttpRouter.add("PATCH", "/api/keys/:id", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const { id } = yield* HttpRouter.params;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));

    if (
      !body || typeof body !== "object" ||
      !("enabled" in body) || typeof body.enabled !== "boolean"
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Enabled must be a boolean." },
        { status: 400 },
      );
    }

    const db = drizzle(env.DB);
    const enabled = body.enabled;
    const [key] = yield* Effect.promise(() => db
      .update(apiKey)
      .set({ enabled })
      .where(and(eq(apiKey.id, id!), eq(apiKey.userId, session.user.id)))
      .returning(publicApiKeyFields),
    );

    if (!key) {
      return HttpServerResponse.jsonUnsafe({ error: "API key not found." }, { status: 404 });
    }
    return HttpServerResponse.jsonUnsafe(key);
  })),

  HttpRouter.add("DELETE", "/api/keys/:id", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const { id } = yield* HttpRouter.params;
    const db = drizzle(env.DB);
    const deleted = yield* Effect.promise(() => db
      .delete(apiKey)
      .where(and(eq(apiKey.id, id!), eq(apiKey.userId, session.user.id)))
      .returning({ id: apiKey.id }),
    );

    if (deleted.length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "API key not found." }, { status: 404 });
    }
    return HttpServerResponse.jsonUnsafe({ success: true });
  })),
).pipe(Layer.provide(userAuth));
