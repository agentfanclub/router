import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { adminUsers, lifetimeUsage } from "./admin";

let sqlite: Database;
const d1 = {
  prepare: (sql: string) => ({
    sql,
    params: [] as unknown[],
    bind(...params: unknown[]) { return { ...this, params }; },
    async all() { return { results: sqlite.query(this.sql).all(...(this.params as never[])) }; },
  }),
} as unknown as D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  const folder = `${import.meta.dir}/../../drizzle`;
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`${folder}/${file}`, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
});
afterEach(() => sqlite.close());

function addUser(id: string) {
  sqlite.run("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)", [id, id, `${id}@example.com`]);
}
function addUsage(userId: string, model: string, tokens: number) {
  sqlite.run(`INSERT INTO usage_total (user_id, model, requests, sessions, input_tokens, output_tokens,
    cached_tokens, club_charge_micro, personal_charge_micro, cost_micro) VALUES (?, ?, 2, 1, ?, 10, ?, 100, 50, 70)`,
  [userId, model, tokens - 10, tokens - 10]);
}

test("empty lifetime totals and empty user page", async () => {
  expect(await lifetimeUsage(d1)).toEqual({ requests: 0, sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, clubChargeMicro: 0, personalChargeMicro: 0, costMicro: 0 });
  expect(await adminUsers(d1, 0)).toEqual({ users: [], page: 0, hasMore: false });
});

test("lifetime totals combine models and users without counting cached input twice", async () => {
  addUser("a");
  addUser("b");
  addUsage("a", "lumen-model", 100);
  addUsage("a", "sarvam-model", 200);
  addUsage("b", "lumen-model", 50);
  expect(await lifetimeUsage(d1)).toEqual({ requests: 6, sessions: 3, inputTokens: 320, outputTokens: 30, totalTokens: 350, clubChargeMicro: 300, personalChargeMicro: 150, costMicro: 210 });
  const page = await adminUsers(d1, 0);
  expect(page.users.map((row) => [row.id, row.totalTokens])).toEqual([["a", 300], ["b", 50]]);
  expect(page.users[0]).toMatchObject({ requests: 4, sessions: 2, clubChargeMicro: 200, personalChargeMicro: 100, costMicro: 140 });
});

test("pages contain 20 users in descending lifetime usage with stable ties and zero usage last", async () => {
  for (let index = 0; index < 43; index++) {
    const id = `u${String(index).padStart(2, "0")}`;
    addUser(id);
    if (index < 41) addUsage(id, "model", 100 + Math.floor(index / 2));
  }
  sqlite.run("INSERT INTO usage_limit (user_id, five_hour_micro, weekly_micro, updated_at) VALUES ('u40', 500, 1000, 0)");
  const pages = await Promise.all([0, 1, 2, 3].map((page) => adminUsers(d1, page)));
  expect(pages.map((page) => page.users.length)).toEqual([20, 20, 3, 0]);
  expect(pages.map((page) => page.hasMore)).toEqual([true, true, false, false]);
  expect(pages[0]!.users[0]).toMatchObject({ id: "u40", totalTokens: 120, fiveHourMicro: 500, weeklyMicro: 1000 });
  const users = pages.flatMap((page) => page.users);
  expect(new Set(users.map((row) => row.id)).size).toBe(43);
  expect(users.map((row) => row.id)).toEqual([...users].sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id)).map((row) => row.id));
  expect(users.at(-1)).toMatchObject({ id: "u42", totalTokens: 0, requests: 0, fiveHourMicro: null, weeklyMicro: null });
});
