import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import models from "../data/models.json";
import { userOrApiKeyAuth } from "../middleware/api-key-auth";

export type ModelCatalog = typeof models;

export const modelRoutes = HttpRouter.add("GET", "/api/models", Effect.succeed(
  HttpServerResponse.jsonUnsafe(models),
)).pipe(
  Layer.provide(HttpRouter.middleware((handler) => handler.pipe(
    Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-store")),
  )).layer),
  Layer.provide(userOrApiKeyAuth),
);
