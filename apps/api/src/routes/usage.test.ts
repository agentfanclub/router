import { expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Db, UsageCoordinator, WorkerExecution } from "../services";
import { usageLimitsRoute } from "./usage";

const window = { usedMicro: 4_000_000, limitMicro: 10_000_000, startMs: 0, resetsInMs: 90_000 };
const snapshot = {
  fiveHour: window,
  weekly: { ...window, usedMicro: 1_000_000, limitMicro: 20_000_000, resetsInMs: 900_000 },
  pendingMicro: 500_000,
};

function makeApp() {
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => [{
              keyId: "test-key",
              userId: "test-user",
              fiveHourMicro: null,
              weeklyMicro: null,
              byokId: null,
              byokCiphertext: null,
            }],
          }),
        }),
      }),
    }),
  };
  const services = Layer.mergeAll(
    Layer.succeed(Db, db as unknown as Db["Service"]),
    Layer.succeed(UsageCoordinator, {
      admit: () => Effect.die("unused"),
      settle: () => Effect.die("unused"),
      status: () => Effect.succeed(snapshot),
    }),
  );
  return HttpRouter.toWebHandler(usageLimitsRoute.pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(services),
  ));
}

test("returns public usage for a bearer API key", async () => {
  const app = makeApp();
  const context = Context.make(WorkerExecution, { waitUntil() { } } as ExecutionContext);

  try {
    const response = await app.handler(new Request("https://router.test/api/usage/limits", {
      headers: { authorization: "Bearer test-key" },
    }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      fiveHour: { usedPercent: 40, pendingPercent: 5, resetsInMs: 90_000 },
      weekly: { usedPercent: 5, pendingPercent: 2.5, resetsInMs: 900_000 },
    });
  } finally {
    await app.dispose();
  }
});

test("rejects a request without a bearer key", async () => {
  const app = makeApp();
  const context = Context.make(WorkerExecution, { waitUntil() { } } as ExecutionContext);

  try {
    const response = await app.handler(new Request("https://router.test/api/usage/limits"), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
  } finally {
    await app.dispose();
  }
});
