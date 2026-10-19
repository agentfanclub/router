import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createAuth } from "./auth";

const routes = Layer.mergeAll(
  HttpRouter.add("*", "/", HttpServerResponse.text("hello world")),
  HttpRouter.add("*", "/api/auth/*", (request) =>
    Effect.gen(function* () {
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.promise(() => createAuth(env).handler(webRequest));
      return HttpServerResponse.fromWeb(response);
    }),
  ),
);

const app = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler<Env>;
