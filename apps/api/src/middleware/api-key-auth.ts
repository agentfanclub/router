import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { apiKey } from "../db/schema";
import { WorkerEnv } from "../worker-env";

export const apiKeyAuth = HttpRouter.middleware()(
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
