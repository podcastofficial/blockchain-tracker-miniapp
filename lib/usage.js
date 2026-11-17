// Feature usage counters (admin "usage stats") + error log + cron heartbeat. Tables are created on first use.
import { db } from "./db.js";

let schemaP;
export const ensureOpsSchema = () => schemaP || (schemaP = db().query(`
CREATE TABLE IF NOT EXISTS feature_usage (
  user_id BIGINT NOT NULL, feature TEXT NOT NULL, day DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, feature, day)
);
CREATE INDEX IF NOT EXISTS idx_feature_usage_day ON feature_usage(day, feature);
CREATE TABLE IF NOT EXISTS error_logs (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL, route TEXT,
  status INTEGER, message TEXT, count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_error_logs_at ON error_logs(at DESC);
CREATE TABLE IF NOT EXISTS cron_runs (
  job TEXT PRIMARY KEY, last_start TIMESTAMPTZ, last_ok TIMESTAMPTZ, last_status INTEGER, last_ms INTEGER, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY, last_ok TIMESTAMPTZ, last_fail TIMESTAMPTZ, last_error TEXT, ok_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0
)`).catch(e => { schemaP = null; throw e; }));

// Fire-and-forget: never blocks or breaks a request.
export function trackUsage(uid, feature, n = 1) {
  if (!uid || !feature) return;
  ensureOpsSchema().then(() => db().query(
    `INSERT INTO feature_usage(user_id, feature, n) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, feature, day) DO UPDATE SET n = feature_usage.n + EXCLUDED.n`, [uid, String(feature).slice(0, 40), n])).catch(() => {});
}
export async function usageToday(uid, feature) {
  try {
    await ensureOpsSchema();
    const r = await db().query(`SELECT n FROM feature_usage WHERE user_id=$1 AND feature=$2 AND day=(NOW() AT TIME ZONE 'UTC')::date`, [uid, feature]);
    return r.rows[0]?.n || 0;
  } catch { return 0; }
}

const seen = new Map();   // same error repeated within 60s on this instance is counted, not re-inserted
export function logError(source, route, status, err) {
  const msg = String((err && err.message) || err || "").replace(/(api[-_]?key|apikey|token|secret)=[^&\s"']+/gi, "$1=***").slice(0, 300);
  const k = `${source}|${route}|${status}|${msg}`, now = Date.now(), prev = seen.get(k);
  if (prev && now - prev < 60000) return;
  seen.set(k, now); if (seen.size > 500) seen.clear();
  console.error("[err]", source, route || "", status || "", msg);
  ensureOpsSchema().then(() => db().query(`INSERT INTO error_logs(source, route, status, message) VALUES ($1,$2,$3,$4)`,
    [String(source).slice(0, 40), route ? String(route).slice(0, 120) : null, status || null, msg])).catch(() => {});
}

export function noteProvider(provider, ok, errMsg) {
  ensureOpsSchema().then(() => ok
    ? db().query(`INSERT INTO provider_health(provider,last_ok,ok_count) VALUES ($1,NOW(),1) ON CONFLICT (provider) DO UPDATE SET last_ok=NOW(), ok_count=provider_health.ok_count+1`, [provider])
    : db().query(`INSERT INTO provider_health(provider,last_fail,last_error,fail_count) VALUES ($1,NOW(),$2,1) ON CONFLICT (provider) DO UPDATE SET last_fail=NOW(), last_error=EXCLUDED.last_error, fail_count=provider_health.fail_count+1`,
      [provider, String(errMsg || "").slice(0, 160)])).catch(() => {});
}

export async function cronBeat(job, status, ms) {
  try {
    await ensureOpsSchema();
    const good = status < 400;
    await db().query(
      `INSERT INTO cron_runs(job,last_start,last_ok,last_status,last_ms,runs,failures) VALUES ($1,NOW(),$2,$3,$4,1,$5)
       ON CONFLICT (job) DO UPDATE SET last_start=NOW(), last_ok=COALESCE($2, cron_runs.last_ok), last_status=$3, last_ms=$4, runs=cron_runs.runs+1, failures=cron_runs.failures+$5`,
      [job, good ? new Date() : null, status, ms, good ? 0 : 1]);
  } catch { /* heartbeat is best-effort */ }
}
