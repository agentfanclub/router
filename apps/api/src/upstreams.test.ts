import { expect, test } from "bun:test";
import { catalog, publicCatalog, upstreamKeys, upstreams } from "./upstreams";
import { parseOpenAiUsage } from "./util/usage";

test("GLM-5.3 offers OpenCode Go after Lumen with a separate public price", () => {
  const model = catalog["glm-5.3"]!;
  expect(model.upstreams.map(({ provider, weight }) => [provider, weight])).toEqual([["lumen", 30], ["opencode-go", 70]]);
  expect(model.upstreams[1]?.slug).toBe("glm-5.3");
  expect(model.upstreams[0]?.cost).toEqual({ input: 1.321413, output: 4.248318, cache_read: 1.321413, cache_write: 0 });
  expect(publicCatalog["glm-5.3"]?.cost).toEqual({ input: 0.6607065, output: 2.124159, cache_read: 0.6607065, cache_write: 0 });
  expect(publicCatalog["glm-5.3"]?.previous_cost).toEqual(model.upstreams[0]?.cost);
  expect(upstreams["opencode-go"].authHeaders("test-key")).toEqual({ authorization: "Bearer test-key" });
  expect(upstreamKeys({} as Parameters<typeof upstreamKeys>[0], "opencode-go")).toEqual([]);
  expect(parseOpenAiUsage({ prompt_tokens: 10, completion_tokens: 1, cost: 0 })?.reportedCostMicro).toBe(0);
});

test("Sarvam uses v2 and subscription-key authentication for both models", () => {
  expect(upstreams.sarvam.url).toBe("https://api.sarvam.ai/v2/chat/completions");
  expect(upstreams.sarvam.authHeaders("test-key")).toEqual({ "api-subscription-key": "test-key" });
  for (const id of ["glm5.3-flash", "sarvam-105b"]) {
    expect(catalog[id]?.upstreams).toEqual([{ provider: "sarvam" }]);
    expect(publicCatalog[id]?.id).toBe(id);
  }
});

test("Lumen retains Bearer authentication", () => {
  expect(upstreams.lumen.authHeaders("test-key")).toEqual({ authorization: "Bearer test-key" });
});

test("Sarvam normalizes token limits and uses model-specific reasoning defaults", () => {
  for (const [model, effort] of [["glm5.3-flash", "low"], ["sarvam-105b", "medium"]]) {
    const body: Record<string, unknown> = { model, max_completion_tokens: 128 };
    upstreams.sarvam.prepareBody?.(body);
    expect(body).toEqual({ model, max_tokens: 128, reasoning_effort: effort });
  }
});

test("Sarvam preserves explicit token limits and reasoning effort", () => {
  const body: Record<string, unknown> = {
    model: "glm5.3-flash", max_tokens: 64, max_completion_tokens: 128, reasoning_effort: "high",
  };
  upstreams.sarvam.prepareBody?.(body);
  expect(body).toEqual({ model: "glm5.3-flash", max_tokens: 64, reasoning_effort: "high" });
});
