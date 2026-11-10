import { Effect } from "effect";
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
// twice. The journal settles records within minutes and logs live 30 days,
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

// Raw logs are kept for this many full Central days, enough for every 30 day
// view. Older logs survive only as daily totals.
export const LOG_RETENTION_DAYS = 30;

const logDay = new SQLiteSyncDialect().sqlToQuery(centralDaySql("created_at")).sql;

// Folds logs from Central days past retention into usage_daily, then deletes
// them, in one transaction so nothing is counted twice or lost.
export function rollUpStatements(d1: D1Database, now: number): { cutoff: number; statements: D1PreparedStatement[] } {
  const cutoff = centralDayStart(addDays(centralDay(now), -LOG_RETENTION_DAYS));
  const rollUp = d1.prepare(`
    WITH logs AS (
      SELECT ${logDay} AS day, * FROM usage_log WHERE created_at < ?1
    ),
    per_model AS (
      SELECT day, user_id, model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        SUM(CASE WHEN billed = 'club' THEN charge_micro ELSE 0 END) AS club_charge_micro,
        SUM(CASE WHEN billed = 'personal' THEN charge_micro ELSE 0 END) AS personal_charge_micro,
        SUM(cost_micro) AS cost_micro
      FROM logs GROUP BY day, user_id, model
    ),
    per_user AS (
      SELECT day, user_id, COUNT(DISTINCT session_id) AS sessions FROM logs GROUP BY day, user_id
    )
    INSERT INTO usage_daily (day, user_id, requests, sessions, input_tokens, output_tokens, cached_tokens,
      club_charge_micro, personal_charge_micro, cost_micro, models)
    SELECT m.day, m.user_id, SUM(m.requests), u.sessions,
      SUM(m.input_tokens), SUM(m.output_tokens), SUM(m.cached_tokens),
      SUM(m.club_charge_micro), SUM(m.personal_charge_micro), SUM(m.cost_micro),
      json_group_object(m.model, json_object(
        'requests', m.requests,
        'inputTokens', m.input_tokens,
        'outputTokens', m.output_tokens,
        'cachedTokens', m.cached_tokens,
        'chargeMicro', m.club_charge_micro + m.personal_charge_micro,
        'costMicro', m.cost_micro
      ))
    FROM per_model m JOIN per_user u USING (day, user_id)
    GROUP BY m.day, m.user_id
    -- Only a log written long after its day was rolled up conflicts. Its
    -- totals are added, but the per-model breakdown keeps the original.
    ON CONFLICT (user_id, day) DO UPDATE SET
      requests = requests + excluded.requests,
      sessions = sessions + excluded.sessions,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      club_charge_micro = club_charge_micro + excluded.club_charge_micro,
      personal_charge_micro = personal_charge_micro + excluded.personal_charge_micro,
      cost_micro = cost_micro + excluded.cost_micro
  `).bind(cutoff);
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
