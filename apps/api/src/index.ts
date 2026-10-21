import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createAuth } from "./auth";
import { apiKeyRoutes } from "./routes/api-keys";
import { deviceAuthRoutes } from "./routes/device-auth";
import { modelRoutes } from "./routes/models";
import { adminRoutes } from "./routes/admin";
import { WorkerEnv } from "./worker-env";

const routes = Layer.mergeAll(
  apiKeyRoutes,
  deviceAuthRoutes,
  modelRoutes,
  adminRoutes,
  HttpRouter.add("*", "/health", HttpServerResponse.text("OK")),
  HttpRouter.add("*", "/api/auth/*", (request) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.promise(() => createAuth(env).handler(webRequest));
      return HttpServerResponse.fromWeb(response);
    }),
  ),
);

const app = HttpRouter.toWebHandler(routes.pipe(
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(Layer.succeed(WorkerEnv, env)),
));

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler<Env>;
