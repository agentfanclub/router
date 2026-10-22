import { setTimeout } from "node:timers/promises";
import type { ProviderConfig as PiProvider } from "@earendil-works/pi-coding-agent";

type LoginCallbacks = Pick<Parameters<NonNullable<PiProvider["oauth"]>["login"]>[0], "onAuth" | "onProgress" | "signal">;
type ApiModel = {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  limit: { context: number; output: number };
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  modalities: { input: ("text" | "image")[]; output: string[] };
};

type Credentials = { access: string; refresh: string; expires: number; apiEndpoint?: unknown };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function createProvider(client: "pi" | "oh-my-pi") {
  const apiURL = new URL(process.env.AGENTFANCLUB_API_URL ?? "https://api.router.agentfan.club");
  if (apiURL.protocol !== "https:" && !(apiURL.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(apiURL.hostname))) {
    throw new Error("AGENTFANCLUB_API_URL must use HTTPS, or HTTP on localhost.");
  }
  if (apiURL.username || apiURL.password || apiURL.pathname !== "/" || apiURL.search || apiURL.hash) {
    throw new Error("AGENTFANCLUB_API_URL must be an origin without a path or credentials.");
  }

  const oauth = {
    name: "Agent Fan Club",
    async login(callbacks: LoginCallbacks) {
      const signal = AbortSignal.any([...(callbacks.signal ? [callbacks.signal] : []), AbortSignal.timeout(10 * 60_000)]);
      const response = await fetch(`${apiURL.origin}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Couldn't start Agent Fan Club sign-in. Try /login again.");
      const attempt: unknown = await response.json();
      if (!object(attempt) || typeof attempt.deviceCode !== "string" || typeof attempt.userCode !== "string" ||
        typeof attempt.verificationURL !== "string" || typeof attempt.expiresAt !== "string" ||
        typeof attempt.interval !== "number" || !Number.isFinite(attempt.interval) || attempt.interval < 1) {
        throw new Error("Agent Fan Club returned an invalid connection request.");
      }
      const expiresAt = Date.parse(attempt.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000) {
        throw new Error("Agent Fan Club returned an invalid connection expiry.");
      }
      callbacks.onAuth({
        url: attempt.verificationURL,
        instructions: `Confirm code ${attempt.userCode} on Agent Fan Club. Only approve the request you started here.`,
      });
      callbacks.onProgress?.("Waiting for browser approval...");
      let interval = attempt.interval;
      while (Date.now() < expiresAt) {
        await setTimeout(interval * 1000, undefined, { signal });
        const response = await fetch(`${apiURL.origin}/api/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: attempt.deviceCode }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        const result: unknown = await response.json();
        if (response.ok && object(result) && typeof result.token === "string" && /^sk-afcrouter-[a-f0-9]{64}$/.test(result.token)) {
          // A revocable API key has no expiry or refresh token. Keep it in the host credential store.
          return { access: result.token, refresh: "", expires: Number.MAX_SAFE_INTEGER, apiEndpoint: apiURL.origin };
        }
        if (object(result) && result.error === "authorization_pending") continue;
        if (object(result) && result.error === "slow_down") { interval += 5; continue; }
        if (object(result) && result.error === "access_denied") throw new Error("Agent Fan Club connection was declined.");
        throw new Error("Agent Fan Club connection expired or failed. Start again with /login.");
      }
      throw new Error("Agent Fan Club connection expired. Start again with /login.");
    },
    async refreshToken<T extends Credentials>(credentials: T) {
      if (credentials.apiEndpoint !== apiURL.origin) throw new Error("The API endpoint changed. Sign in again with /login.");
      return credentials;
    },
    getApiKey(credentials: Credentials) {
      if (credentials.apiEndpoint !== apiURL.origin) throw new Error("The API endpoint changed. Sign in again with /login.");
      return credentials.access;
    },
  };

  async function fetchModels(token: string | undefined, signal?: AbortSignal) {
    if (!token) return [];
    const response = await fetch(`${apiURL.origin}/api/models`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error("Couldn't load Agent Fan Club models. Check your connection and sign in again with /login.");
    const result = await response.json() as Record<string, ApiModel>;
    return Object.values(result).map((model) => ({
      id: model.id,
      name: model.name,
      api: "openai-completions" as const,
      input: model.modalities.input,
      reasoning: model.reasoning,
      contextWindow: model.limit.context,
      maxTokens: model.limit.output,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache_read,
        cacheWrite: model.cost.cache_write,
      },
    }));
  }

  return { baseUrl: `${apiURL.origin}/inference/v1`, oauth, fetchModels };
}
