import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { apiKey } from "../db/schema";
import { decodeBody, failWith } from "../http";
import { UserSession, userAuth } from "../middleware/user-auth";
import { Db, query } from "../services";
import { createApiKey, publicApiKeyFields } from "../util/keys";

export type ApiKey = Pick<typeof apiKey.$inferSelect, "id" | "name" | "lastFive" | "enabled"> & {
  createdAt: string;
};

const CreateKey = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
});

const UpdateKey = Schema.Struct({ enabled: Schema.Boolean });

const keyId = Effect.map(HttpRouter.params, (params) => params.id!);

export const apiKeyRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/keys", Effect.fn("listApiKeys")(function* () {
    const session = yield* UserSession;
    const keys = yield* query((db) => db
      .select(publicApiKeyFields)
      .from(apiKey)
      .where(eq(apiKey.userId, session.user.id))
      .orderBy(desc(apiKey.createdAt)));
    return HttpServerResponse.jsonUnsafe(keys);
  })),

  HttpRouter.add("POST", "/api/keys", Effect.fn("createApiKey")(function* () {
    const session = yield* UserSession;
    const { name } = yield* decodeBody(CreateKey, "Enter a key name between 1 and 80 characters.");
    const db = yield* Db;
    const created = yield* query(() => createApiKey({ db, userId: session.user.id, name }));
    return HttpServerResponse.jsonUnsafe(created, { status: 201 });
  })),

  HttpRouter.add("PATCH", "/api/keys/:id", Effect.fn("updateApiKey")(function* () {
    const session = yield* UserSession;
    const id = yield* keyId;
    const { enabled } = yield* decodeBody(UpdateKey, "Enabled must be a boolean.");
    const [key] = yield* query((db) => db
      .update(apiKey)
      .set({ enabled })
      .where(and(eq(apiKey.id, id), eq(apiKey.userId, session.user.id)))
      .returning(publicApiKeyFields));
    if (!key) return yield* failWith(404, "API key not found.");
    return HttpServerResponse.jsonUnsafe(key);
  })),

  HttpRouter.add("DELETE", "/api/keys/:id", Effect.fn("deleteApiKey")(function* () {
    const session = yield* UserSession;
    const id = yield* keyId;
    const deleted = yield* query((db) => db
      .delete(apiKey)
      .where(and(eq(apiKey.id, id), eq(apiKey.userId, session.user.id)))
      .returning({ id: apiKey.id }));
    if (deleted.length === 0) return yield* failWith(404, "API key not found.");
    return HttpServerResponse.jsonUnsafe({ success: true });
  })),
).pipe(Layer.provide(userAuth));
