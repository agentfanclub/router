import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { UserUsage } from "./user-usage";

// Runs the Durable Object against in-memory SQLite. D1 is only used to mirror
// settled usage logs, which these admission tests do not exercise.
function makeInstance() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS windows (name TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, used_micro INTEGER NOT NULL)");
  db.exec("BEGIN");
  db.exec("INSERT OR IGNORE INTO windows (name, start_ms, used_micro) VALUES ('five_hour', ?, 0), ('weekly', ?, 0)", [Date.now(), Date.now()]);
  db.exec("COMMIT");
  const d1 = {
    prepare: () => {
      throw new Error("D1 not available");
    },
  };
  const storage = {
    sql: {
      exec: (query: string, ...params: unknown[]) => ({
        toArray: () => db.query(query).all(...(params as never[])),
      }),
    },
    get: async () => true,
    put: async () => {},
    setAlarm: async () => {},
    getAlarm: async () => null,
    deleteAlarm: async () => {},
    transactionSync: (fn: () => void) => {
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const state = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
  } as unknown as DurableObjectState;
  return new UserUsage(state, { DB: d1 } as never);
}

// Two different prices so the reserved amount reveals which route was chosen.
const LUMEN = { input: 1, output: 1, cacheRead: 1 };
const SARVAM = { input: 0.15, output: 0.6, cacheRead: 0.05 };

function admit(
  usage: UserUsage,
  overrides: {
    upstreams?: Partial<{ clubLumen: "ok" | "dry"; byok: boolean; opencodeGo: boolean; sarvam: boolean }>;
    sarvamPriced?: boolean;
    limits?: { fiveHourMicro: number; weeklyMicro: number };
  } = {},
) {
  return usage.fetch(new Request("https://usage/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      sessionId: `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      userId: "test-user",
      apiKeyId: "test-key",
      model: "sarvam-105b",
      createdAt: Date.now(),
      inputEstimateTokens: 20,
      maxOutputTokens: 16384,
      limits: overrides.limits ?? { fiveHourMicro: 10_000_000, weeklyMicro: 50_000_000 },
      upstreams: { clubLumen: "dry", byok: false, opencodeGo: false, sarvam: true, ...overrides.upstreams },
      sarvamPriced: overrides.sarvamPriced ?? true,
      prices: { clubLumen: LUMEN, sarvam: overrides.sarvamPriced === false ? undefined : SARVAM },
    }),
  }));
}

describe("admission", () => {
  test("the Sarvam model reserves at the Sarvam price", async () => {
    const decision = await (await admit(makeInstance())).json();
    expect(decision).toMatchObject({ decision: "admit" });
    // 20 * 0.15 + 16384 * 0.6 = 9,833 at Sarvam, versus 16,404 at Lumen's
    // price, so the reservation reveals which route was chosen.
    expect(decision.reservedMicro).toBe(9_833);
  });

  test("without a Sarvam key the model reserves at the Lumen price", async () => {
    const decision = await (await admit(makeInstance(), { upstreams: { clubLumen: "ok", sarvam: false }, sarvamPriced: false })).json();
    expect(decision).toMatchObject({ decision: "admit" });
    expect(decision.reservedMicro).toBe(16_404);
  });

  test("a Sarvam model without a Sarvam price is rejected, never Lumen-priced", async () => {
    const instance = makeInstance();
    const response = await instance.fetch(new Request("https://usage/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        userId: "test-user",
        apiKeyId: "test-key",
        model: "sarvam-105b",
        createdAt: Date.now(),
        inputEstimateTokens: 20,
        maxOutputTokens: 16384,
        limits: { fiveHourMicro: 10_000_000, weeklyMicro: 50_000_000 },
        upstreams: { clubLumen: "ok", byok: false, opencodeGo: false, sarvam: true },
        sarvamPriced: true,
        prices: { clubLumen: LUMEN },
      }),
    }));
    expect(response.status).toBe(400);
  });

  test("no upstream at all still denies", async () => {
    const decision = await (await admit(makeInstance(), { upstreams: { sarvam: false } })).json();
    expect(decision).toMatchObject({ decision: "deny", reason: "no_upstream" });
  });
});
