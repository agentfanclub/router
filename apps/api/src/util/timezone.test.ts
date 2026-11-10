import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { centralDay, centralDaySql, centralDayStart, centralOffsetMinutes } from "./timezone";

test("the SQL day expression matches centralDay, including across daylight time changes", () => {
  const { sql } = new SQLiteSyncDialect().sqlToQuery(centralDaySql("?1"));
  const query = new Database(":memory:").query<{ day: string }, [number]>(`SELECT ${sql} AS day`);
  const edges = ["2026-03-08T07:59:59.999Z", "2026-03-08T08:00:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z"];
  const samples = edges.map(Date.parse);
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2029, 0, 1); ms += 37 * 60 * 1000) samples.push(ms);
  for (const ms of samples) expect(query.get(ms)!.day).toBe(centralDay(ms));
});

test("Central offsets and day starts follow daylight time", () => {
  expect(centralOffsetMinutes(Date.parse("2026-07-01T12:00:00Z"))).toBe(-300);
  expect(centralOffsetMinutes(Date.parse("2026-12-01T12:00:00Z"))).toBe(-360);
  expect(new Date(centralDayStart("2026-07-01")).toISOString()).toBe("2026-07-01T05:00:00.000Z");
  expect(new Date(centralDayStart("2026-11-01")).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  expect(new Date(centralDayStart("2026-11-02")).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  expect(new Date(centralDayStart("2026-03-08")).toISOString()).toBe("2026-03-08T06:00:00.000Z");
});
