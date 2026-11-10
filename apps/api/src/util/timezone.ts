import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

// Usage is bucketed into calendar days on Central time (America/Chicago),
// following daylight saving, so every view and every user shares one
// calendar. Days are `YYYY-MM-DD` strings.

const centralDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const centralParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

// The Central calendar day containing an epoch-millisecond timestamp.
export function centralDay(ms: number): string {
  return centralDate.format(ms);
}

// Central time's offset from UTC at `ms`, in minutes east (-300 or -360).
export function centralOffsetMinutes(ms: number): number {
  const parts = Object.fromEntries(centralParts.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  const wallClock = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((wallClock - Math.floor(ms / 1000) * 1000) / 60_000);
}

// The day `count` calendar days after `day`. Negative counts go back.
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + count)).toISOString().slice(0, 10);
}

// Start of a Central calendar day, as epoch milliseconds. Midnight is never
// skipped or repeated: daylight time changes at 2am.
export function centralDayStart(day: string): number {
  // Central midnight is 5 hours (daylight) or 6 hours (standard) after UTC midnight.
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const daylight = utcMidnight + 5 * 60 * 60 * 1000;
  return centralDay(daylight) === day && centralDay(daylight - 1) !== day ? daylight : daylight + 60 * 60 * 1000;
}

// SQLite expression for the Central day of an epoch-millisecond column,
// matching `centralDay`. US daylight time runs from 2am on the second Sunday
// of March (08:00 UTC) to 2am on the first Sunday of November (07:00 UTC).
export function centralDaySql(column: SQLWrapper | string): SQL<string> {
  const ms = typeof column === "string" ? sql.raw(column) : column;
  const seconds = sql`(${ms} / 1000)`;
  const year = sql`strftime('%Y', ${seconds}, 'unixepoch')`;
  const dstStart = sql`CAST(strftime('%s', ${year} || '-03-01', 'weekday 0', '+7 days', '+8 hours') AS INTEGER)`;
  const dstEnd = sql`CAST(strftime('%s', ${year} || '-11-01', 'weekday 0', '+7 hours') AS INTEGER)`;
  return sql<string>`strftime('%Y-%m-%d', ${seconds} - CASE WHEN ${seconds} >= ${dstStart} AND ${seconds} < ${dstEnd} THEN 18000 ELSE 21600 END, 'unixepoch')`;
}
