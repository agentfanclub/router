import models from "./data/models.json";
import type { ApiEnv } from "./env";

export type UpstreamId = "lumen" | "sarvam";
// "byok" is the user's personal Lumen key. It serves any model Lumen serves.
export type UpstreamRoute = UpstreamId | "byok";

interface Upstream {
  name: string;
  url: string;
  credential: (env: ApiEnv) => string | undefined;
  // Adjusts the outgoing chat body for provider quirks.
  prepareBody?: (body: Record<string, unknown>) => void;
}

export const upstreams: Record<UpstreamId, Upstream> = {
  lumen: {
    name: "Lumen",
    url: "https://lumen.ncsa.illinois.edu/v1/chat/completions",
    credential: (env) => env.LUMEN_API_KEY,
  },
  sarvam: {
    name: "Sarvam",
    url: "https://api.sarvam.ai/v1/chat/completions",
    credential: (env) => env.SARVAM_API_KEY,
    prepareBody(body) {
      // Sarvam only understands max_tokens, and reasons at length unless
      // given an effort. Reasoning tokens are billed as output.
      if (body.max_tokens === undefined && body.max_completion_tokens !== undefined) {
        body.max_tokens = body.max_completion_tokens;
      }
      delete body.max_completion_tokens;
      body.reasoning_effort ??= "medium";
    },
  },
};

type RawModel = (typeof models)[keyof typeof models];

export type PublicModel = Omit<RawModel, "upstreams">;

// Upstreams are listed in priority order. They are internal and never served
// to clients.
export interface CatalogModel extends PublicModel {
  upstreams: UpstreamId[];
}

export const catalog = models as unknown as Record<string, CatalogModel>;

for (const [id, model] of Object.entries(catalog)) {
  if (model.upstreams.length === 0 || model.upstreams.some((upstream) => !(upstream in upstreams))) {
    throw new Error(`Model ${id} has invalid upstreams: ${JSON.stringify(model.upstreams)}`);
  }
}

export const publicCatalog: Record<string, PublicModel> = Object.fromEntries(
  Object.entries(catalog).map(([id, { upstreams: _, ...model }]) => [id, model]),
);
