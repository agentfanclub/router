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
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];

      if (!token) {
        return HttpServerResponse.jsonUnsafe({
          error: { message: "A bearer API key is required.", type: "authentication_error", code: "invalid_api_key", param: null },
        }, { status: 401 });
      }

      const hash = createHash("sha256").update(token).digest("hex");
      const db = drizzle(env.DB);
      const [key] = yield* Effect.promise(() => db
        .select({ id: apiKey.id })
        .from(apiKey)
        .where(and(eq(apiKey.hash, hash), eq(apiKey.enabled, true)))
        .limit(1),
      );

      if (!key) {
        return HttpServerResponse.jsonUnsafe({
          error: { message: "Invalid or disabled API key.", type: "authentication_error", code: "invalid_api_key", param: null },
        }, { status: 401 });
      }

      return yield* handler;
    });
  }),
).layer;

export const apiKeyAuth = makeApiKeyAuth(false);
export const userOrApiKeyAuth = makeApiKeyAuth(true);

// Gates on a valid API key and resolves whose allowance the request draws on.
// Used by the inference route, which needs the user identity and limits.
export const inferenceKeyAuth = HttpRouter.middleware<{ provides: ApiKeyIdentity }>()(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];

      if (!token) {
        return HttpServerResponse.jsonUnsafe({
          error: { message: "A bearer API key is required.", type: "authentication_error", code: "invalid_api_key", param: null },
        }, { status: 401 });
      }

      const hash = createHash("sha256").update(token).digest("hex");
      const db = drizzle(env.DB);
      const [row] = yield* Effect.promise(() => db
        .select({
          keyId: apiKey.id,
          userId: apiKey.userId,
          fiveHourMicro: usageLimit.fiveHourMicro,
          weeklyMicro: usageLimit.weeklyMicro,
          byokId: sql<string | null>`(
            SELECT id FROM byok_key
            WHERE user_id = ${apiKey.userId} AND status = 'active'
            ORDER BY created_at ASC LIMIT 1
          )`,
          byokCiphertext: sql<string | null>`(
            SELECT ciphertext FROM byok_key
            WHERE user_id = ${apiKey.userId} AND status = 'active'
            ORDER BY created_at ASC LIMIT 1
          )`,
        })
        .from(apiKey)
        .leftJoin(usageLimit, eq(usageLimit.userId, apiKey.userId))
        .where(and(eq(apiKey.hash, hash), eq(apiKey.enabled, true)))
        .limit(1),
      );

      if (!row) {
        return HttpServerResponse.jsonUnsafe({
          error: { message: "Invalid or disabled API key.", type: "authentication_error", code: "invalid_api_key", param: null },
        }, { status: 401 });
      }

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
