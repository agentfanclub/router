import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import type { UpstreamRoute } from "../upstreams";

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
  const d1 = { prepare: () => statement };
  return new UserUsage({ storage } as unknown as DurableObjectState, { DB: d1 } as never);
}

const LIMITS = { fiveHourMicro: 10_000_000, weeklyMicro: 50_000_000 };

function admit(usage: InstanceType<typeof UserUsage>, overrides: {
  routes?: UpstreamRoute[];
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
    reserveMicro: overrides.reserveMicro ?? 1_000,
    limits: LIMITS,
  });
}

function spend(usage: InstanceType<typeof UserUsage>, costMicro: number) {
  const requestId = crypto.randomUUID();
  return admit(usage, { requestId }).then(() => usage.settle({
    requestId,
    route: "lumen",
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    costMicro,
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
});

describe("settlement", () => {
  test("charges actual cost and releases the reservation", async () => {
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
      costMicro: 5_000, status: "ok", durationMs: 1, limits: LIMITS,
    });
    expect(snapshot.fiveHour.usedMicro).toBe(0);
  });
});
