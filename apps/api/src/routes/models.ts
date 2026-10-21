import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import models from "../data/models.json";
import { apiKeyAuth } from "../middleware/api-key-auth";

export const modelRoutes = HttpRouter.add("GET", "/api/models", Effect.succeed(
  HttpServerResponse.jsonUnsafe(models),
)).pipe(
  Layer.provide(HttpRouter.middleware((handler) => handler.pipe(
    Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-store")),
  )).layer),
  Layer.provide(apiKeyAuth),
);
