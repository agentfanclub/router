import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createAuth } from "../auth";
import { apiKey, usageLimit } from "../db/schema";
import { DEFAULT_FIVE_HOUR_LIMIT_MICRO, DEFAULT_WEEKLY_LIMIT_MICRO, type UsageLimits } from "../util/usage";
import { WorkerEnv } from "../worker-env";

export interface ApiKeyIdentityValue {
  keyId: string;
  userId: string;
  limits: UsageLimits;
  // The user's oldest active personal Lumen key, when one exists. The
  // ciphertext is decrypted only if a request is actually routed to it.
  byok: { id: string; ciphertext: string } | null;
}

export class ApiKeyIdentity extends Context.Service<ApiKeyIdentity, ApiKeyIdentityValue>()("router/ApiKeyIdentity") {}

function bearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? null;
}

function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(message: string) {
  return HttpServerResponse.jsonUnsafe({
    error: { message, type: "authentication_error", code: "invalid_api_key", param: null },
  }, { status: 401 });
}

const missingKey = () => unauthorized("A bearer API key is required.");
const invalidKey = () => unauthorized("Invalid or disabled API key.");

const makeApiKeyAuth = (allowUserSession: boolean) => HttpRouter.middleware()(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (allowUserSession && !request.headers.authorization) {
        const session = yield* Effect.promise(() => createAuth(env).api.getSession({
          headers: new Headers(request.headers),
        }));
        if (session) return yield* handler;
      }
      const token = bearerToken(request);
      if (!token) return missingKey();

      const [key] = yield* Effect.promise(() => drizzle(env.DB)
        .select({ id: apiKey.id })
        .from(apiKey)
        .where(and(eq(apiKey.hash, hashKey(token)), eq(apiKey.enabled, true)))
        .limit(1),
      );
      if (!key) return invalidKey();
      return yield* handler;
    });
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
    const env = yield* WorkerEnv;

    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = bearerToken(request);
      if (!token) return missingKey();

      const [row] = yield* Effect.promise(() => drizzle(env.DB)
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
        .where(and(eq(apiKey.hash, hashKey(token)), eq(apiKey.enabled, true)))
        .limit(1),
      );
      if (!row) return invalidKey();

      const identity: ApiKeyIdentityValue = {
        keyId: row.keyId,
        userId: row.userId,
        limits: {
          fiveHourMicro: row.fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO,
          weeklyMicro: row.weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO,
        },
        byok: row.byokId && row.byokCiphertext ? { id: row.byokId, ciphertext: row.byokCiphertext } : null,
      };
      return yield* Effect.provideService(handler, ApiKeyIdentity, identity);
    });
  }),
).layer;
