import models from "./data/models.json";
import type { ApiEnv } from "./env";

export type UpstreamId = "lumen" | "sarvam";
// "byok" is the user's personal Lumen key. It serves any model Lumen serves.
export type UpstreamRoute = UpstreamId | "byok";

interface Upstream {
  name: string;
  url: string;
  // Secret holding the upstream's API keys, comma or whitespace separated.
  // Each request picks one at random, which spreads load across per-key
  // rate limits.
  keysSecret: "LUMEN_API_KEYS" | "SARVAM_API_KEY";
  // Adjusts the outgoing chat body for provider quirks.
  prepareBody?: (body: Record<string, unknown>) => void;
}

export const upstreams: Record<UpstreamId, Upstream> = {
  lumen: {
    name: "Lumen",
    url: "https://lumen.ncsa.illinois.edu/v1/chat/completions",
    keysSecret: "LUMEN_API_KEYS",
  },
  sarvam: {
    name: "Sarvam",
    url: "https://api.sarvam.ai/v1/chat/completions",
    keysSecret: "SARVAM_API_KEY",
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

export function upstreamKeys(env: ApiEnv, id: UpstreamId): string[] {
  return env[upstreams[id].keysSecret]?.split(/[\s,]+/).filter(Boolean) ?? [];
}

type RawModel = (typeof models)[keyof typeof models];

// `cost` is what router users pay, in USD per million tokens.
export type PublicModel = Omit<RawModel, "upstreams" | "upstream_cost">;
export type ModelCost = PublicModel["cost"];

// Upstreams are listed in priority order. They and their prices are internal
// and never served to clients.
export interface CatalogModel extends PublicModel {
  upstreams: UpstreamId[];
  // What each upstream charges the club, when it differs from `cost`.
  upstream_cost?: Partial<Record<UpstreamId, ModelCost>>;
}

export const catalog = models as unknown as Record<string, CatalogModel>;

for (const [id, model] of Object.entries(catalog)) {
  if (model.upstreams.length === 0 || model.upstreams.some((upstream) => !(upstream in upstreams))) {
    throw new Error(`Model ${id} has invalid upstreams: ${JSON.stringify(model.upstreams)}`);
  }
}

export const publicCatalog: Record<string, PublicModel> = Object.fromEntries(
  Object.entries(catalog).map(([id, { upstreams: _, upstream_cost: __, ...model }]) => [id, model]),
);
