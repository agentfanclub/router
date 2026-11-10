import { Effect } from "effect";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { usageLog } from "./db/schema";
import { query } from "./services";
import { addDays, centralDay, centralDaySql, centralDayStart } from "./util/timezone";

// JSON-safe copy of a usage_log row, as the UserUsage journal holds it.
export type UsageRecord = Omit<typeof usageLog.$inferSelect, "createdAt"> & { createdAt: number };

// Statements that write one journal record to usage_log and fold it into
// usage_total. They must run in one D1 batch, which is a transaction.
//
// The journal writes a record more than once (admitted, then settled, and
// again on a retry), so the total takes the difference: the new record minus
// the logged row, if there is one, before the row is overwritten. Writing the
// same version twice changes nothing.
//
// A record re-written after the rollup deleted its log row would be counted
// twice. The journal settles records within minutes and logs live 7 days,
// so that never happens in practice.
export function usageWriteStatements(d1: D1Database, record: UsageRecord): D1PreparedStatement[] {
  const total = d1.prepare(`
    INSERT INTO usage_total (user_id, model, requests, sessions, input_tokens, output_tokens, cached_tokens,
      club_charge_micro, personal_charge_micro, cost_micro)
    SELECT ?1, ?2,
      CASE WHEN old.id IS NULL THEN 1 ELSE 0 END,
      -- A session counts once, when the first of its requests is logged.
      CASE WHEN old.id IS NULL AND ?4 IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM usage_log WHERE session_id = ?4 AND user_id = ?1) THEN 1 ELSE 0 END,
      ?5 - COALESCE(old.input_tokens, 0),
      ?6 - COALESCE(old.output_tokens, 0),
      ?7 - COALESCE(old.cached_tokens, 0),
      CASE WHEN ?3 = 'club' THEN ?8 ELSE 0 END - CASE WHEN old.billed = 'club' THEN old.charge_micro ELSE 0 END,
      CASE WHEN ?3 = 'personal' THEN ?8 ELSE 0 END - CASE WHEN old.billed = 'personal' THEN old.charge_micro ELSE 0 END,
      ?9 - COALESCE(old.cost_micro, 0)
    FROM (SELECT 1) LEFT JOIN usage_log AS old ON old.id = ?10
    WHERE true
    ON CONFLICT (user_id, model) DO UPDATE SET
      requests = requests + excluded.requests,
      sessions = sessions + excluded.sessions,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      club_charge_micro = club_charge_micro + excluded.club_charge_micro,
      personal_charge_micro = personal_charge_micro + excluded.personal_charge_micro,
      cost_micro = cost_micro + excluded.cost_micro
  `).bind(
    record.userId, record.model, record.billed, record.sessionId,
    record.inputTokens ?? 0, record.outputTokens ?? 0, record.cachedTokens ?? 0,
    record.chargeMicro, record.costMicro, record.id,
  );

  const log = d1.prepare(`
    INSERT INTO usage_log (id, user_id, api_key_id, session_id, model, upstream, billed, input_tokens, output_tokens,
      cached_tokens, charge_micro, cost_micro, estimated, status, duration_ms, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ON CONFLICT (id) DO UPDATE SET upstream = excluded.upstream, billed = excluded.billed,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens,
      charge_micro = excluded.charge_micro, cost_micro = excluded.cost_micro, estimated = excluded.estimated,
      status = excluded.status, duration_ms = excluded.duration_ms
  `).bind(
    record.id, record.userId, record.apiKeyId, record.sessionId, record.model, record.upstream, record.billed,
    record.inputTokens, record.outputTokens, record.cachedTokens, record.chargeMicro, record.costMicro,
    record.estimated ? 1 : 0, record.status, record.durationMs, record.createdAt,
  );

  return [total, log];
}

// Raw logs are kept for this many full Central days before today. They back
// the logs and sessions pages; older usage survives only as daily totals.
export const LOG_RETENTION_DAYS = 7;

// Renders a drizzle SQL fragment as a D1 statement.
const dialect = new SQLiteSyncDialect();
function prepare(d1: D1Database, query: SQL): D1PreparedStatement {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return d1.prepare(text).bind(...params);
}

const DAILY_COLUMNS = sql.raw(`user_id, day, model, requests, sessions, input_tokens, output_tokens, cached_tokens,
  club_charge_micro, personal_charge_micro, cost_micro`);

// Logs summed into usage_daily rows. A session counts once per user and day,
// under the model of its first request that day.
function logsByDay(filter: SQL): SQL {
  return sql`
    SELECT user_id, day, model,
      COUNT(*) AS requests,
      SUM(CASE WHEN session_id IS NOT NULL AND session_order = 1 THEN 1 ELSE 0 END) AS sessions,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(CASE WHEN billed = 'club' THEN charge_micro ELSE 0 END), 0) AS club_charge_micro,
      COALESCE(SUM(CASE WHEN billed = 'personal' THEN charge_micro ELSE 0 END), 0) AS personal_charge_micro,
      COALESCE(SUM(cost_micro), 0) AS cost_micro
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id, day, session_id ORDER BY created_at, id) AS session_order
      FROM (SELECT *, ${centralDaySql("created_at")} AS day FROM usage_log WHERE ${filter})
    )
    GROUP BY user_id, day, model`;
}

export interface DailyUsageRow {
  userId: string;
  day: string;
  model: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  clubChargeMicro: number;
  personalChargeMicro: number;
  costMicro: number;
}

// Usage per user, Central day, and model from `since` through today, from
// rolled-up days and the logs not yet rolled up. Optionally one user's only.
export async function dailyUsage(d1: D1Database, { since, userId }: { since: string; userId?: string }): Promise<DailyUsageRow[]> {
  const forUser = userId === undefined ? sql`` : sql` AND user_id = ${userId}`;
  const { results } = await prepare(d1, sql`
    SELECT user_id AS userId, day, model, requests, sessions, input_tokens AS inputTokens, output_tokens AS outputTokens,
      cached_tokens AS cachedTokens, club_charge_micro AS clubChargeMicro, personal_charge_micro AS personalChargeMicro,
      cost_micro AS costMicro
    FROM (
      SELECT ${DAILY_COLUMNS} FROM usage_daily WHERE day >= ${since}${forUser}
      UNION ALL
      ${logsByDay(sql`created_at >= ${centralDayStart(since)}${forUser}`)}
    )
    ORDER BY day, model`).all<DailyUsageRow>();
  return results;
}

// Folds logs from Central days past retention into usage_daily, then deletes
// them, in one transaction so nothing is counted twice or lost.
export function rollUpStatements(d1: D1Database, now: number): { cutoff: number; statements: D1PreparedStatement[] } {
  const cutoff = centralDayStart(addDays(centralDay(now), -LOG_RETENTION_DAYS));
  const rollUp = prepare(d1, sql`
    INSERT INTO usage_daily (${DAILY_COLUMNS})
    SELECT * FROM (${logsByDay(sql`created_at < ${cutoff}`)}) WHERE true
    -- Only a log written long after its day was rolled up conflicts.
    ON CONFLICT (user_id, day, model) DO UPDATE SET
      requests = requests + excluded.requests,
      sessions = sessions + excluded.sessions,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      club_charge_micro = club_charge_micro + excluded.club_charge_micro,
      personal_charge_micro = personal_charge_micro + excluded.personal_charge_micro,
      cost_micro = cost_micro + excluded.cost_micro`);
  const prune = d1.prepare("DELETE FROM usage_log WHERE created_at < ?1").bind(cutoff);
  return { cutoff, statements: [rollUp, prune] };
}

// Runs daily at 06:15 UTC (Cloudflare cron schedules are always UTC), just
// after Central midnight in both standard and daylight time.
export const rollUpUsageLogs = Effect.fn("rollUpUsageLogs")(function* (now: number = Date.now()) {
  const { cutoff, deletedLogs } = yield* query(async ({ $client: d1 }) => {
    const { cutoff, statements } = rollUpStatements(d1, now);
    const [, deleted] = await d1.batch(statements);
    return { cutoff, deletedLogs: deleted!.meta.changes };
  });
  console.info({ event: "usage_rollup", cutoff, deletedLogs });
});
