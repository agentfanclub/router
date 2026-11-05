import { sql } from "drizzle-orm";

// Calendar bucketing helpers for the usage charts.
//
// Timestamps are stored as epoch milliseconds and charted as calendar days.
// The web app sends the viewer's UTC offset so those days match the viewer's
// own calendar rather than UTC: a person in UTC-8 should see their 11pm
// requests land on the day they actually made them. The offset is minutes
// east of UTC, matching `Date.prototype.getTimezoneOffset()` negated, and is
// clamped so a bad value can never shift the window by more than a day.

const MAX_OFFSET_MINUTES = 14 * 60;

export function parseUtcOffsetMinutes(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, value));
}

// Start of the viewer's current calendar day, as epoch milliseconds.
export function localDayStart(now: number, offsetMinutes: number): number {
  const shifted = now + offsetMinutes * 60_000;
  return Math.floor(shifted / 86_400_000) * 86_400_000 - offsetMinutes * 60_000;
}

// SQLite fragment that renders an epoch-millisecond column as a `YYYY-MM-DD`
// string on the viewer's calendar.
export function calendarDay(column: unknown, offsetMinutes: number) {
  return sql<string>`strftime('%Y-%m-%d', ${column} / 1000 + ${offsetMinutes * 60}, 'unixepoch')`;
}
