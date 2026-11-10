import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import { rollUpStatements, usageWriteStatements, type UsageRecord } from "./usage-aggregates";

// Applies the real migrations to in-memory SQLite and runs statements
// through a minimal D1 stand-in.
let sqlite: Database;
const d1 = {
  prepare: (sql: string) => ({ sql, params: [] as unknown[], bind(...params: unknown[]) { return { ...this, params }; } }),
  batch: async (statements: { sql: string; params: unknown[] }[]) => sqlite.transaction(() =>
    statements.map(({ sql, params }) => ({ meta: { changes: sqlite.query(sql).run(...(params as never[])).changes } })))(),
} as unknown as D1Database;

const migrations = readdirSync(`${import.meta.dir}/../drizzle`).filter((name) => name.endsWith(".sql")).sort();
function migrate(files: string[]) {
  for (const file of files) {
    for (const statement of readFileSync(`${import.meta.dir}/../drizzle/${file}`, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
}
function freshDatabase(files = migrations) {
  sqlite = new Database(":memory:");
  migrate(files);
  sqlite.run(`INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'U', 'u@example.com', 0, 0)`);
}

const write = (record: UsageRecord) => d1.batch(usageWriteStatements(d1, record));
const totals = () => sqlite.query(`SELECT * FROM usage_total ORDER BY model`).all();

const createdAt = Date.parse("2026-11-01T05:30:00Z");
const pending = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id: "req-1", userId: "u1", apiKeyId: "k1", sessionId: "ses_a", model: "glm-5.3", upstream: "lumen", billed: "club",
  inputTokens: null, outputTokens: null, cachedTokens: null, chargeMicro: 0, costMicro: 0, estimated: false,
  status: "pending", durationMs: null, createdAt, ...overrides,
});
const settled = (overrides: Partial<UsageRecord> = {}) => pending({
  inputTokens: 100, outputTokens: 50, cachedTokens: 10, chargeMicro: 900, costMicro: 600, status: "ok", durationMs: 5, ...overrides,
});

beforeEach(() => freshDatabase());

describe("lifetime totals", () => {
  test("re-writing a record replaces its contribution instead of adding to it", async () => {
    await write(pending());
    await write(settled());
    await write(settled());
    expect(totals()).toMatchObject([{
      model: "glm-5.3", requests: 1, sessions: 1, input_tokens: 100, output_tokens: 50, cached_tokens: 10,
      club_charge_micro: 900, personal_charge_micro: 0, cost_micro: 600,
    }]);
  });

  test("a record that fails over to the user's key moves its charge", async () => {
    await write(settled());
    await write(settled({ upstream: "byok", billed: "personal", costMicro: 0 }));
    expect(totals()).toMatchObject([{ requests: 1, club_charge_micro: 0, personal_charge_micro: 900, cost_micro: 0 }]);
  });

  test("a session counts once across requests", async () => {
    await write(settled());
    await write(settled({ id: "req-2" }));
    await write(settled({ id: "req-3", sessionId: "ses_b" }));
    await write(pending({ id: "req-4", sessionId: null, status: "denied" }));
    expect(totals()).toMatchObject([{ requests: 4, sessions: 2 }]);
  });
});

test("the backfill migration matches live writes", async () => {
  // Club rows logged before the split had one price for both sides.
  const records = [
    settled({ costMicro: 900 }),
    settled({ id: "req-2", costMicro: 900, model: "deepseek-v4-flash" }),
    settled({ id: "req-3", costMicro: 900, sessionId: "ses_b", createdAt: createdAt + 1000 }),
    settled({ id: "req-4", upstream: "byok", billed: "personal", costMicro: 0, sessionId: "ses_b", createdAt: createdAt + 2000 }),
    pending({ id: "req-5", sessionId: null, status: "denied" }),
  ];
  for (const record of records) await write(record);
  const live = totals();

  // Before the split, cost_micro held the user's charge on every row.
  const backfill = migrations.findIndex((name) => name.startsWith("0010_"));
  freshDatabase(migrations.slice(0, backfill));
  const insert = sqlite.query(`INSERT INTO usage_log (id, user_id, api_key_id, session_id, model, upstream, billed, input_tokens,
    output_tokens, cached_tokens, cost_micro, estimated, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of records) {
    insert.run(r.id, r.userId, r.apiKeyId, r.sessionId, r.model, r.upstream, r.billed, r.inputTokens, r.outputTokens,
      r.cachedTokens, r.chargeMicro, r.estimated ? 1 : 0, r.status, r.durationMs, r.createdAt);
  }
  migrate(migrations.slice(backfill));
  expect(totals()).toEqual(live);
  expect(sqlite.query(`SELECT charge_micro, cost_micro FROM usage_log WHERE id = 'req-4'`).get()).toEqual({ charge_micro: 900, cost_micro: 0 });
});

test("the rollup folds logs past retention into Central days and deletes them", async () => {
  const now = Date.parse("2026-12-01T06:15:00Z"); // 00:15 CST on Dec 1. Logs from Nov 1 onward stay.
  await write(settled({ id: "a", createdAt: Date.parse("2026-11-01T04:59:00Z") })); // Oct 31, 23:59 CDT
  await write(settled({ id: "b", createdAt: Date.parse("2026-10-31T05:00:00Z"), model: "deepseek-v4-flash", upstream: "byok", billed: "personal", costMicro: 0 }));
  await write(settled({ id: "c", createdAt: Date.parse("2026-11-01T05:00:00Z") })); // Nov 1, 00:00 CDT
  const before = totals();

  const { cutoff, statements } = rollUpStatements(d1, now);
  expect(new Date(cutoff).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  await d1.batch(statements);

  expect(sqlite.query(`SELECT id FROM usage_log`).all()).toEqual([{ id: "c" }]);
  const [day] = sqlite.query(`SELECT * FROM usage_daily`).all() as Record<string, unknown>[];
  expect(day).toMatchObject({ day: "2026-10-31", requests: 2, sessions: 1, club_charge_micro: 900, personal_charge_micro: 900, cost_micro: 600 });
  expect(JSON.parse(day!.models as string)).toEqual({
    "glm-5.3": { requests: 1, inputTokens: 100, outputTokens: 50, cachedTokens: 10, chargeMicro: 900, costMicro: 600 },
    "deepseek-v4-flash": { requests: 1, inputTokens: 100, outputTokens: 50, cachedTokens: 10, chargeMicro: 900, costMicro: 0 },
  });
  expect(totals()).toEqual(before);
});
