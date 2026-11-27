import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { UpstreamRoute, UpstreamWeights } from "../upstreams";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) { }
  },
}));
const { UserUsage } = await import("./user-usage");

// Runs the Durable Object against in-memory SQLite. D1 is only a mirror of the
// journal, so writes to it are accepted and dropped.
function makeInstance() {
  const db = new Database(":memory:");
  const storage = {
    sql: {
      exec: (query: string, ...params: unknown[]) => ({
        toArray: () => db.query(query).all(...(params as never[])),
      }),
    },
    setAlarm: async () => { },
    getAlarm: async () => null,
    transactionSync: (fn: () => void) => db.transaction(fn)(),
  };
  const statement = { bind: () => statement, run: async () => ({ success: true, results: [] }) };
  const d1 = { prepare: () => statement, batch: async () => [] };
  return new UserUsage({ storage } as unknown as DurableObjectState, { DB: d1 } as never);
}

const LIMITS = { fiveHourMicro: 10_000_000, weeklyMicro: 50_000_000 };

function admit(usage: InstanceType<typeof UserUsage>, overrides: {
  routes?: UpstreamRoute[];
  upstreamWeights?: UpstreamWeights;
  reserveMicro?: number;
  sessionId?: string;
  requestId?: string;
} = {}) {
  return usage.admit({
    requestId: overrides.requestId ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    userId: "test-user",
    apiKeyId: "test-key",
    model: "test-model",
    createdAt: Date.now(),
    routes: overrides.routes ?? ["lumen"],
    upstreamWeights: overrides.upstreamWeights,
    reserveMicro: overrides.reserveMicro ?? 1_000,
    limits: LIMITS,
  });
}

function spend(usage: InstanceType<typeof UserUsage>, chargeMicro: number) {
  const requestId = crypto.randomUUID();
  return admit(usage, { requestId }).then(() => usage.settle({
    requestId,
    route: "lumen",
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    chargeMicro,
    costMicro: chargeMicro,
    status: "ok",
    durationMs: 1,
    limits: LIMITS,
  }));
}

describe("admission", () => {
  test("admits on the first route and reserves its cost", async () => {
    const usage = makeInstance();
    const decision = await admit(usage, { routes: ["sarvam", "lumen"], reserveMicro: 5_000 });
    expect(decision).toMatchObject({ decision: "admit", route: "sarvam" });
    expect((await usage.status(LIMITS)).pendingMicro).toBe(5_000);
  });

  test("admits a request whose reservation exceeds the remaining allowance", async () => {
    const usage = makeInstance();
    await spend(usage, 9_999_000);
    const decision = await admit(usage, { reserveMicro: 2_000_000 });
    expect(decision).toMatchObject({ decision: "admit", route: "lumen" });
  });

  test("denies once spend reaches the limit", async () => {
    const usage = makeInstance();
    await spend(usage, 10_000_000);
    expect(await admit(usage)).toMatchObject({ decision: "deny", reason: "five_hour_cap" });
  });

  test("in-flight reservations count toward the limit", async () => {
    const usage = makeInstance();
    await spend(usage, 9_000_000);
    expect(await admit(usage, { reserveMicro: 1_000_000 })).toMatchObject({ decision: "admit" });
    expect(await admit(usage)).toMatchObject({ decision: "deny", reason: "five_hour_cap" });
  });

  test("over the limit, the user's own key serves without a reservation", async () => {
    const usage = makeInstance();
    await spend(usage, 10_000_000);
    expect(await admit(usage, { routes: ["lumen", "byok"] })).toMatchObject({ decision: "admit", route: "byok" });
    expect((await usage.status(LIMITS)).pendingMicro).toBe(0);
  });

  test("a session stays on its route while that route is available", async () => {
    const usage = makeInstance();
    const sessionId = "ses_0123456789abcdef";
    await admit(usage, { sessionId, routes: ["sarvam"] });
    expect(await admit(usage, { sessionId, routes: ["lumen", "sarvam"] })).toMatchObject({ route: "sarvam" });
    expect(await admit(usage, { sessionId, routes: ["lumen"] })).toMatchObject({ route: "lumen" });
  });

  test("weights choose the initial route and subsequent requests keep that route", async () => {
    const usage = makeInstance();
    const routes: UpstreamRoute[] = ["lumen", "sarvam", "byok"];
    const options = { routes, upstreamWeights: { lumen: 70, sarvam: 30 } };
    const sessionId = "ses_0123456789abcdef";
    const random = spyOn(Math, "random").mockReturnValue(0.7);
    try {
      expect(await admit(usage, { ...options, sessionId })).toMatchObject({ route: "sarvam" });
      random.mockReturnValue(0.69);
      expect(await admit(usage, { ...options, sessionId })).toMatchObject({ route: "sarvam" });
      expect(await admit(usage, options)).toMatchObject({ route: "lumen" });
    } finally {
      random.mockRestore();
    }
  });

  test("a zero-weight route can serve when the weighted upstream is unavailable", async () => {
    const usage = makeInstance();
    const upstreamWeights = { lumen: 0, sarvam: 100 };
    expect(await admit(usage, { upstreamWeights, routes: ["lumen", "sarvam"] })).toMatchObject({ route: "sarvam" });
    expect(await admit(usage, { upstreamWeights, routes: ["lumen", "byok"] })).toMatchObject({ route: "lumen" });
  });
});

describe("settlement", () => {
  test("charges the user's price and releases the reservation", async () => {
    const usage = makeInstance();
    const snapshot = await spend(usage, 1_234);
    expect(snapshot.fiveHour.usedMicro).toBe(1_234);
    expect(snapshot.weekly.usedMicro).toBe(1_234);
    expect(snapshot.pendingMicro).toBe(0);
  });

  test("usage on the user's own key is not charged", async () => {
    const usage = makeInstance();
    const requestId = crypto.randomUUID();
    await admit(usage, { requestId, routes: ["byok"] });
    const snapshot = await usage.settle({
      requestId, route: "byok", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      chargeMicro: 5_000, costMicro: 0, status: "ok", durationMs: 1, limits: LIMITS,
    });
    expect(snapshot.fiveHour.usedMicro).toBe(0);
  });
});

describe("reset", () => {
  test("clears one window and lets a capped user back in", async () => {
    const usage = makeInstance();
    await spend(usage, 10_000_000);
    expect(await admit(usage)).toMatchObject({ decision: "deny", reason: "five_hour_cap" });

    const snapshot = await usage.reset("five_hour", LIMITS);
    expect(snapshot.fiveHour).toMatchObject({ usedMicro: 0, resetsInMs: 0 });
    expect(snapshot.weekly.usedMicro).toBe(10_000_000);
    expect(await admit(usage)).toMatchObject({ decision: "admit" });
  });

  test("a late settlement from before the reset is not charged to the new window", async () => {
    const usage = makeInstance();
    const requestId = crypto.randomUUID();
    const start = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    await admit(usage, { requestId });
    await usage.reset("weekly", LIMITS);
    clock.mockReturnValue(start + 1_000);
    await spend(usage, 100);
    clock.mockRestore();
    const snapshot = await usage.settle({
      requestId, route: "lumen", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      chargeMicro: 5_000, costMicro: 5_000, status: "ok", durationMs: 1, limits: LIMITS,
    });
    expect(snapshot.weekly.usedMicro).toBe(100);
    expect(snapshot.fiveHour.usedMicro).toBe(5_100);
  });
});
