import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { userOrApiKeyAuth } from "../middleware/api-key-auth";
import { publicCatalog } from "../upstreams";

export type ModelCatalog = typeof publicCatalog;

export const modelRoutes = HttpRouter.add("GET", "/api/models", Effect.succeed(
  HttpServerResponse.jsonUnsafe(publicCatalog),
)).pipe(
  Layer.provide(HttpRouter.middleware((handler) => handler.pipe(
    Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-store")),
  )).layer),
  Layer.provide(userOrApiKeyAuth),
);
