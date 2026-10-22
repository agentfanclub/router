import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { WorkerEnv } from "../worker-env";

const handleRequest = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!env.LUMEN_API_KEY) {
    return HttpServerResponse.jsonUnsafe({
      error: { message: "Lumen API key is not configured.", type: "server_error", code: null, param: null },
    }, { status: 503 });
  }

  const webRequest = yield* HttpServerRequest.toWeb(request);
  const url = new URL(webRequest.url);
  const headers = new Headers({ authorization: `Bearer ${env.LUMEN_API_KEY}` });
  for (const name of ["content-type", "accept"]) {
    const value = webRequest.headers.get(name);
    if (value) headers.set(name, value);
  }

  return yield* Effect.tryPromise(() => fetch(`https://lumen.ncsa.illinois.edu/v1/chat/completions${url.search}`, {
    method: webRequest.method,
    headers,
    body: webRequest.body,
    signal: webRequest.signal,
    redirect: "manual",
  })).pipe(
    Effect.map(HttpServerResponse.fromWeb),
    Effect.orElseSucceed(() => HttpServerResponse.jsonUnsafe({
      error: { message: "Unable to reach Lumen.", type: "server_error", code: null, param: null },
    }, { status: 502 })),
  );
});

export const inferenceRoutes = HttpRouter.add("POST", "/inference/v1/chat/completions", handleRequest).pipe(
  Layer.provide(apiKeyAuth),
);
