import { expect, spyOn, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Db, UsageCoordinator, WorkerEnv, WorkerExecution } from "../services";
import { catalog } from "../upstreams";
import { inferenceRoutes } from "./inference";

test.each([
  { model: "router-test-model", firstRoute: "lumen", fallback: "sarvam", weights: { lumen: 70, sarvam: 30 } },
  { model: "glm-5.3", firstRoute: "opencode-go", fallback: "lumen", weights: { lumen: 30, "opencode-go": 70 } },
] as const)("$model uses the fallback when $firstRoute returns 429", async ({ model, firstRoute, fallback, weights }) => {
  if (model === "router-test-model") {
    catalog[model] = {
      ...catalog["glm5.3-flash"]!,
      id: model,
      upstreams: [
        { provider: "lumen", slug: "lumen-model", weight: 70 },
        { provider: "sarvam", slug: "glm5.3-flash", weight: 30 },
      ],
    };
  }
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({ limit: async () => [{ keyId: "test-key", userId: "test-user" }] }),
        }),
      }),
    }),
  };
  const window = { usedMicro: 0, limitMicro: 1000, startMs: 0, resetsInMs: 0 };
  const snapshot = { fiveHour: window, weekly: window, pendingMicro: 0 };
  const services = Layer.mergeAll(
    Layer.succeed(Db, db as unknown as Db["Service"]),
    Layer.succeed(WorkerEnv, { LUMEN_API_KEYS: "lumen-key", SARVAM_API_KEY: "sarvam-key", OPENCODE_GO_API_KEY: "go-key" } as WorkerEnv["Service"]),
    Layer.succeed(UsageCoordinator, {
      admit: (input) => Effect.sync(() => {
        expect(input.model).toBe(model);
        expect(input.upstreamWeights).toEqual(weights);
        return { decision: "admit", route: firstRoute, snapshot } as const;
      }),
      settle: (_userId, input) => Effect.sync(() => {
        expect(input.route).toBe(fallback);
        return snapshot;
      }),
      status: () => Effect.succeed(snapshot),
    }),
  );
  const app = HttpRouter.toWebHandler(inferenceRoutes.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(services)));
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    const hostname = new URL(String(input)).hostname;
    if (hostname === "opencode.ai") {
      expect(body.model).toBe("glm-5.3");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer go-key");
      return Response.json({ error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } }, { status: 429 });
    }
    if (hostname === "lumen.ncsa.illinois.edu" && firstRoute === "lumen") {
      expect(body.model).toBe("lumen-model");
      return Response.json({ error: "rate limited" }, { status: 429 });
    }
    if (fallback === "sarvam") {
      expect(hostname).toBe("api.sarvam.ai");
      expect(body).toMatchObject({ model: "glm5.3-flash", reasoning_effort: "low" });
    } else {
      expect(hostname).toBe("lumen.ncsa.illinois.edu");
      expect(body.model).toBe("glm-5.3");
    }
    const result = { model: body.model, choices: [{ index: 0 }] };
    return body.stream
      ? new Response(`id: 1\ndata: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
      : Response.json(result);
  });
  const context = Context.make(WorkerExecution, { waitUntil() {} } as ExecutionContext);

  try {
    for (const stream of [false, true]) {
      const response = await app.handler(new Request("https://router.test/inference/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: JSON.stringify({ model, stream, messages: [] }),
      }), context);
      expect(response.status).toBe(200);
      const result = { model, choices: [{ index: 0 }] };
      if (stream) expect(await response.text()).toBe(`id: 1\ndata: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);
      else expect(await response.json()).toEqual(result);
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally {
    fetch.mockRestore();
    if (model === "router-test-model") delete catalog[model];
    await app.dispose();
  }
});
