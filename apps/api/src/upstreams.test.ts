import { expect, test } from "bun:test";
import { catalog, publicCatalog, upstreams } from "./upstreams";

test("Sarvam uses v2 and subscription-key authentication for both models", () => {
  expect(upstreams.sarvam.url).toBe("https://api.sarvam.ai/v2/chat/completions");
  expect(upstreams.sarvam.authHeaders("test-key")).toEqual({ "api-subscription-key": "test-key" });
  for (const id of ["glm5.3-flash", "sarvam-105b"]) {
    expect(catalog[id]?.upstreams).toEqual(["sarvam"]);
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
