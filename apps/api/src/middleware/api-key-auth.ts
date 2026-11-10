import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { apiKey, usageLimit } from "../db/schema";
import { OpenAiError } from "../http";
import { Auth, Db, getSession, query } from "../services";
import { DEFAULT_FIVE_HOUR_LIMIT_MICRO, DEFAULT_WEEKLY_LIMIT_MICRO, type UsageLimits } from "../util/usage";

export interface ApiKeyIdentityValue {
  keyId: string;
  userId: string;
  limits: UsageLimits;
  // The user's oldest active personal Lumen key, when one exists. The
  // ciphertext is decrypted only if a request is actually routed to it.
  byok: { id: string; ciphertext: string } | null;
}

export class ApiKeyIdentity extends Context.Service<ApiKeyIdentity, ApiKeyIdentityValue>()("router/ApiKeyIdentity") { }

const unauthorized = (message: string) =>
  new OpenAiError({ status: 401, message, code: "invalid_api_key", type: "authentication_error" });

// The SHA-256 hash of the request's bearer token, which is how keys are stored.
const bearerKeyHash = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!token) return yield* unauthorized("A bearer API key is required.");
  return createHash("sha256").update(token).digest("hex");
});

const invalidKey = () => unauthorized("Invalid or disabled API key.");

const makeApiKeyAuth = (allowUserSession: boolean) => HttpRouter.middleware()(
  Effect.gen(function* () {
    const services = yield* Effect.context<Auth | Db>();
    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (allowUserSession && !request.headers.authorization && (yield* getSession(request.headers))) {
        return yield* handler;
      }
      const hash = yield* bearerKeyHash;
      const [key] = yield* query((db) => db
        .select({ id: apiKey.id })
        .from(apiKey)
        .where(and(eq(apiKey.hash, hash), eq(apiKey.enabled, true)))
        .limit(1));
      if (!key) return yield* invalidKey();
      return yield* handler;
    }).pipe(Effect.provideContext(services));
  }),
).layer;

export const apiKeyAuth = makeApiKeyAuth(false);
export const userOrApiKeyAuth = makeApiKeyAuth(true);

// The user's oldest active personal Lumen key.
const oldestByokKey = (column: "id" | "ciphertext") => sql<string | null>`(
  SELECT ${sql.raw(column)} FROM byok_key
  WHERE user_id = ${apiKey.userId} AND status = 'active'
  ORDER BY created_at ASC LIMIT 1
)`;

// Gates on a valid API key and resolves whose allowance the request draws on.
export const inferenceKeyAuth = HttpRouter.middleware<{ provides: ApiKeyIdentity }>()(
  Effect.gen(function* () {
    const services = yield* Effect.context<Db>();
    return (handler) => Effect.gen(function* () {
      const hash = yield* bearerKeyHash;
      const [row] = yield* query((db) => db
        .select({
          keyId: apiKey.id,
          userId: apiKey.userId,
          fiveHourMicro: usageLimit.fiveHourMicro,
          weeklyMicro: usageLimit.weeklyMicro,
          byokId: oldestByokKey("id"),
          byokCiphertext: oldestByokKey("ciphertext"),
        })
        .from(apiKey)
        .leftJoin(usageLimit, eq(usageLimit.userId, apiKey.userId))
        .where(and(eq(apiKey.hash, hash), eq(apiKey.enabled, true)))
        .limit(1));
      if (!row) return yield* invalidKey();

      return yield* Effect.provideService(handler, ApiKeyIdentity, {
        keyId: row.keyId,
        userId: row.userId,
        limits: {
          fiveHourMicro: row.fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO,
          weeklyMicro: row.weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO,
        },
        byok: row.byokId && row.byokCiphertext ? { id: row.byokId, ciphertext: row.byokCiphertext } : null,
      });
    }).pipe(Effect.provideContext(services));
  }),
).layer;
