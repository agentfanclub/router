import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { byokKey } from "../db/schema";
import { decodeBody, failWith } from "../http";
import { UserSession, userAuth } from "../middleware/user-auth";
import { query, WorkerEnv } from "../services";
import { encryptSecret } from "../util/secret-box";

export type ByokKeyRow = Pick<typeof byokKey.$inferSelect, "id" | "label" | "lastFive" | "status" | "createdAt">;

const publicFields = {
  id: byokKey.id,
  label: byokKey.label,
  lastFive: byokKey.lastFive,
  status: byokKey.status,
  createdAt: byokKey.createdAt,
};

const AddKey = Schema.Struct({
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  key: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.isPattern(/^\S+$/)),
});

// Verifies a key against Lumen's usage endpoint, which authenticates the key
// and confirms it belongs to a real account.
const verifyWithLumen = Effect.fn("verifyWithLumen")(function* (key: string) {
  const response = yield* Effect.tryPromise(() => fetch("https://lumen.ncsa.illinois.edu/v1/usage", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  })).pipe(Effect.orElseSucceed(() => null));
  if (response?.status === 401 || response?.status === 403) {
    return yield* failWith(400, "Lumen rejected this key. Check that it is valid and active.");
  }
  if (!response?.ok) return yield* failWith(502, "Unable to reach Lumen to verify this key. Try again.");
});

export const byokRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/byok/keys", Effect.fn("listByokKeys")(function* () {
    const session = yield* UserSession;
    const keys = yield* query((db) => db
      .select(publicFields)
      .from(byokKey)
      .where(eq(byokKey.userId, session.user.id))
      .orderBy(desc(byokKey.createdAt)));
    return HttpServerResponse.jsonUnsafe(keys satisfies ByokKeyRow[]);
  })),

  HttpRouter.add("POST", "/api/byok/keys", Effect.fn("addByokKey")(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const encryptionKey = env.BYOK_ENCRYPTION_KEY;
    if (!encryptionKey) return yield* failWith(503, "Personal Lumen keys are not configured on this router.");

    const { label, key } = yield* decodeBody(AddKey, "Enter a label between 1 and 80 characters and the Lumen API key to add.");
    yield* verifyWithLumen(key);
    const ciphertext = yield* Effect.promise(() => encryptSecret(key, encryptionKey));
    const [created] = yield* query((db) => db
      .insert(byokKey)
      .values({ id: crypto.randomUUID(), userId: session.user.id, label, ciphertext, lastFive: key.slice(-5), status: "active" })
      .returning(publicFields));
    return HttpServerResponse.jsonUnsafe(created satisfies ByokKeyRow, { status: 201 });
  })),

  HttpRouter.add("DELETE", "/api/byok/keys/:id", Effect.fn("deleteByokKey")(function* () {
    const session = yield* UserSession;
    const { id } = yield* HttpRouter.params;
    const deleted = yield* query((db) => db
      .delete(byokKey)
      .where(and(eq(byokKey.id, id!), eq(byokKey.userId, session.user.id)))
      .returning({ id: byokKey.id }));
    if (deleted.length === 0) return yield* failWith(404, "Key not found.");
    return HttpServerResponse.jsonUnsafe({ success: true });
  })),
).pipe(Layer.provide(userAuth));
