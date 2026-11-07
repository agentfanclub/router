import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { adminRoutes } from "./routes/admin";
import { apiKeyRoutes } from "./routes/api-keys";
import { byokRoutes } from "./routes/byok";
import { deviceAuthRoutes } from "./routes/device-auth";
import { inferenceRoutes } from "./routes/inference";
import { modelRoutes } from "./routes/models";
import { usageRoutes } from "./routes/usage";
import { Auth, servicesLayer, WorkerExecution } from "./services";

export { UserUsage } from "./do/user-usage";

const routes = Layer.mergeAll(
  apiKeyRoutes,
  byokRoutes,
  deviceAuthRoutes,
  inferenceRoutes,
  modelRoutes,
  adminRoutes,
  usageRoutes,
  HttpRouter.add("*", "/health", HttpServerResponse.text("OK")),
  HttpRouter.add("*", "/api/auth/*", Effect.fn("auth")(function* (request) {
    const auth = yield* Auth;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.promise(() => auth.handler(webRequest));
    return HttpServerResponse.fromWeb(response);
  })),
);

const app = HttpRouter.toWebHandler(routes.pipe(
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(servicesLayer(env)),
));

export default {
  fetch: (request, _env, ctx) => app.handler(request, Context.make(WorkerExecution, ctx)),
} satisfies ExportedHandler<Env>;
