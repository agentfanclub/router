import models from "./data/models.json";
import type { ApiEnv } from "./env";

export type UpstreamId = "lumen" | "sarvam" | "opencode-go";
// "byok" is the user's personal Lumen key. It serves any model Lumen serves.
export type UpstreamRoute = UpstreamId | "byok";
export type UpstreamWeights = Partial<Record<UpstreamId, number>>;

interface Upstream {
  name: string;
  url: string;
  // Secret holding the upstream's API keys, comma or whitespace separated.
  // Each request picks one at random, which spreads load across per-key
  // rate limits.
  keysSecret: "LUMEN_API_KEYS" | "SARVAM_API_KEY" | "OPENCODE_GO_API_KEY";
  authHeaders: (key: string) => Record<string, string>;
  userAgent?: string;
  // Adjusts the outgoing chat body for provider quirks.
  prepareBody?: (body: Record<string, unknown>) => void;
}

export const upstreams: Record<UpstreamId, Upstream> = {
  lumen: {
    name: "Lumen",
    url: "https://lumen.ncsa.illinois.edu/v1/chat/completions",
    keysSecret: "LUMEN_API_KEYS",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  },
  sarvam: {
    name: "Sarvam",
    url: "https://api.sarvam.ai/v2/chat/completions",
    keysSecret: "SARVAM_API_KEY",
    authHeaders: (key) => ({ "api-subscription-key": key }),
    prepareBody(body) {
      // Sarvam only understands max_tokens, and reasons at length unless
      // given an effort. Reasoning tokens are billed as output.
      if (body.max_tokens === undefined && body.max_completion_tokens !== undefined) {
        body.max_tokens = body.max_completion_tokens;
      }
      delete body.max_completion_tokens;
      // GLM accepts low/high/max, while Sarvam 105B also accepts medium.
      body.reasoning_effort ??= body.model === "glm5.3-flash" ? "low" : "medium";
    },
  },
  "opencode-go": {
    name: "OpenCode Go",
    url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    keysSecret: "OPENCODE_GO_API_KEY",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    userAgent: "agentfanclub-router/1.0",
  },
};

export function upstreamKeys(env: ApiEnv, id: UpstreamId): string[] {
  return env[upstreams[id].keysSecret]?.split(/[\s,]+/).filter(Boolean) ?? [];
}

type RawModel = (typeof models)[keyof typeof models];

// `cost` is what router users pay, in USD per million tokens.
export type ModelCost = RawModel["cost"];
export type PublicModel = Omit<RawModel, "upstreams"> & { previous_cost?: ModelCost };

interface ModelUpstream {
  provider: UpstreamId;
  // The provider's model slug. Defaults to the requested public ID.
  slug?: string;
  // Relative weight for the first attempt when there is no eligible saved route.
  weight?: number;
  // What the provider charges the club, when it differs from the public price.
  cost?: ModelCost;
}

// Upstream entries are internal and listed in fallback order.
export interface CatalogModel extends PublicModel {
  upstreams: ModelUpstream[];
}

export const catalog = models as unknown as Record<string, CatalogModel>;

for (const [id, model] of Object.entries(catalog)) {
  const providers = new Set(model.upstreams.map((entry) => entry?.provider));
  if (providers.size === 0 || providers.size !== model.upstreams.length || model.upstreams.some((entry) =>
    !Object.hasOwn(upstreams, entry?.provider) ||
    (entry.slug !== undefined && (typeof entry.slug !== "string" || !entry.slug.trim()))
  )) {
    throw new Error(`Model ${id} has invalid upstreams: ${JSON.stringify(model.upstreams)}`);
  }
  if (model.upstreams.some((entry) => entry.weight !== undefined)) {
    const total = model.upstreams.reduce((sum, entry) => sum + (entry.weight ?? 0), 0);
    if (model.upstreams.some(({ weight }) => weight === undefined || !Number.isFinite(weight) || weight < 0) ||
      !Number.isFinite(total) || total <= 0) {
      throw new Error(`Model ${id} must give every upstream a finite, non-negative weight with a positive total.`);
    }
  }
}

export function modelUpstream(model: CatalogModel, route: UpstreamRoute): ModelUpstream | undefined {
  const provider = route === "byok" ? "lumen" : route;
  return model.upstreams.find((entry) => entry.provider === provider);
}

export function pickClubUpstream(routes: UpstreamId[], weights?: UpstreamWeights): UpstreamId | undefined {
  if (!weights || routes.length < 2) return routes[0];

  const total = routes.reduce((sum, route) => sum + (weights[route] ?? 0), 0);
  if (total === 0) return routes[0];

  let remaining = Math.random() * total;
  let lastWeightedRoute: UpstreamId | undefined;
  for (const route of routes) {
    const weight = weights[route] ?? 0;
    if (weight === 0) continue;
    lastWeightedRoute = route;
    remaining -= weight;
    if (remaining < 0) return route;
  }
  return lastWeightedRoute;
}

export const publicCatalog: Record<string, PublicModel> = Object.fromEntries(
  Object.entries(catalog).map(([id, { upstreams: _, ...model }]) => [id, model]),
);
