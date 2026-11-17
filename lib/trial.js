// Free trial: one per user, TRIAL_DAYS (default 3) of Pro-level access. planOf() (lib/plans.js) reports "pro" while a trial is active,
// so every limit / feature gate follows automatically and nothing is stacked onto paid subscriptions.
//   GET  /api/trial/status      POST /api/trial/start
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { trackUsage } from "./usage.js";

export const TRIAL_DAYS = Math.min(Math.max(parseInt(process.env.TRIAL_DAYS || "3", 10) || 3, 1), 30);
let schemaP;
const ensure = () => schemaP || (schemaP = db().query(`CREATE TABLE IF NOT EXISTS user_trials (
  user_id BIGINT PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, plan_code TEXT NOT NULL DEFAULT 'pro')`)
  .catch(e => { schemaP = null; throw e; }));

export async function trialRow(uid) {
  await ensure();
  return (await db().query(`SELECT started_at, expires_at, plan_code, (expires_at > NOW()) AS active FROM user_trials WHERE user_id=$1`, [uid])).rows[0] || null;
}
export async function trialActive(uid) {
  try { const t = await trialRow(uid); return !!(t && t.active); } catch { return false; }
}

export async function trialApi(req, res, path) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "trial", s.id, 10)) return;
  try {
    const t = await trialRow(s.id);
    const paid = (await db().query(`SELECT 1 FROM user_subscriptions WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [s.id])).rowCount > 0;
    if (path === "/api/trial/status") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      return send(res, 200, { ok: true, days: TRIAL_DAYS, used: !!t, active: !!t?.active, expiresAt: t?.expires_at || null, paid, canStart: !t && !paid });
    }
    if (path === "/api/trial/start") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (paid) return send(res, 409, { ok: false, error: "ALREADY_SUBSCRIBED" });
      if (t) return send(res, 409, { ok: false, error: t.active ? "TRIAL_ALREADY_ACTIVE" : "TRIAL_ALREADY_USED" });
      const r = await db().query(`INSERT INTO user_trials(user_id, expires_at) VALUES ($1, NOW() + ($2 || ' days')::interval) ON CONFLICT (user_id) DO NOTHING RETURNING expires_at`, [s.id, String(TRIAL_DAYS)]);
      if (!r.rowCount) return send(res, 409, { ok: false, error: "TRIAL_ALREADY_USED" });
      trackUsage(s.id, "trial_start");
      return send(res, 200, { ok: true, active: true, days: TRIAL_DAYS, expiresAt: r.rows[0].expires_at });
    }
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) { console.error("[trial]", e.message); return send(res, 500, { ok: false, error: "TRIAL_FAILED" }); }
}
