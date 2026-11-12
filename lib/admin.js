// Server-side admin API. Access = Telegram user id listed in ADMIN_TELEGRAM_IDS (comma separated).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { channelsAdmin } from "./channels.js";

function adminOf(req, res) {
  const s = readSession(req);
  if (!s) { send(res, 401, { ok: false, error: "AUTH_REQUIRED" }); return null; }
  const ids = String(process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!ids.includes(String(s.telegram_user_id))) { send(res, 403, { ok: false, error: "FORBIDDEN" }); return null; }
  if (rateLimited(req, res, "admin", s.id, 60)) return null;
  return s;
}
const audit = (actor, action, entity, id, meta) => db().query(
  `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
  [actor, action, entity, String(id), JSON.stringify(meta || {})]).catch(() => {});

export async function adminApi(req, res, path) {
  const s = adminOf(req, res); if (!s) return;
  const q = new URL(req.url, "https://x.invalid").searchParams;
  try {
    if (path === "/api/admin/stats") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const one = async sql => (await db().query(sql)).rows[0];
      const [u, subs, rev, pay, al, ev, cron, err] = await Promise.all([
        one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new24h, COUNT(*) FILTER (WHERE is_blocked)::int AS blocked FROM users`),
        db().query(`SELECT plan_code, COUNT(*)::int AS n FROM user_subscriptions WHERE status='active' AND (expires_at IS NULL OR expires_at > NOW()) GROUP BY plan_code`),
        one(`SELECT COALESCE(SUM(expected_amount),0)::float8 AS m30, COALESCE(SUM(expected_amount) FILTER (WHERE confirmed_at > NOW() - INTERVAL '24 hours'),0)::float8 AS d1 FROM subscription_payments WHERE status='confirmed' AND confirmed_at > NOW() - INTERVAL '30 days'`),
        one(`SELECT COUNT(*) FILTER (WHERE status IN ('pending','verifying') AND expires_at > NOW())::int AS open FROM subscription_payments`),
        one(`SELECT (SELECT COUNT(*) FROM onchain_alerts WHERE status='active')::int AS onchain, (SELECT COUNT(*) FROM price_alerts WHERE status='active')::int AS price`),
        one(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS events24h, COUNT(*) FILTER (WHERE delivery_status='failed' AND created_at > NOW() - INTERVAL '24 hours')::int AS failed24h FROM alert_events`),
        one(`SELECT MAX(last_run_at) AS last_run FROM onchain_alerts`),
        one(`SELECT COUNT(*) FILTER (WHERE last_error IS NOT NULL)::int AS n FROM onchain_alerts WHERE status='active'`)
      ]);
      return send(res, 200, { ok: true, users: u, subscriptions: subs.rows, revenue30dUsdt: rev.m30, revenue24hUsdt: rev.d1,
        openInvoices: pay.open, alerts: al, events: ev, worker: { lastRun: cron.last_run, rulesWithErrors: err.n }, now: new Date().toISOString() });
    }
    if (path === "/api/admin/payments") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const st = q.get("status");
      const r = await db().query(
        `SELECT p.id, p.plan_code, p.chain, p.expected_amount::text AS amount, p.status, p.tx_hash, p.failure_reason, p.created_at, p.confirmed_at,
                u.telegram_user_id, u.username
         FROM subscription_payments p JOIN users u ON u.id=p.user_id
         WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.created_at DESC LIMIT 50`, [["pending","verifying","confirmed","rejected","expired"].includes(st) ? st : null]);
      return send(res, 200, { ok: true, payments: r.rows });
    }
    if (path === "/api/admin/users") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const term = String(q.get("q") || "").trim().slice(0, 64);
      const r = await db().query(
        `SELECT u.id, u.telegram_user_id, u.username, u.first_name, u.is_blocked, u.created_at, u.last_login_at,
                COALESCE((SELECT plan_code FROM user_subscriptions s WHERE s.user_id=u.id AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at > NOW()) ORDER BY s.expires_at DESC NULLS FIRST LIMIT 1),'free') AS plan
         FROM users u
         WHERE ($1='' OR u.username ILIKE $2 OR u.telegram_user_id::text=$1 OR u.id::text=$1)
         ORDER BY u.created_at DESC LIMIT 30`, [term, "%" + term.replace(/[%_]/g, "") + "%"]);
      return send(res, 200, { ok: true, users: r.rows });
    }
    if (path === "/api/admin/user") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const uid = Number(req.body?.userId), action = req.body?.action;
      if (!Number.isSafeInteger(uid) || !["block", "unblock"].includes(action)) return send(res, 400, { ok: false, error: "INVALID_REQUEST" });
      if (uid === s.id) return send(res, 400, { ok: false, error: "CANNOT_BLOCK_SELF" });
      const r = await db().query(`UPDATE users SET is_blocked=$2, updated_at=NOW() WHERE id=$1 RETURNING id`, [uid, action === "block"]);
      if (!r.rowCount) return send(res, 404, { ok: false, error: "USER_NOT_FOUND" });
      await audit(s.id, "admin." + action, "user", uid);
      return send(res, 200, { ok: true });
    }
    if (path === "/api/admin/grant") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const uid = Number(req.body?.userId), plan = String(req.body?.planCode || ""), days = Number(req.body?.days);
      if (!Number.isSafeInteger(uid) || !["pro", "business", "enterprise"].includes(plan) || !Number.isInteger(days) || days < 1 || days > 3650)
        return send(res, 400, { ok: false, error: "INVALID_REQUEST" });
      const ok = await db().query(`SELECT 1 FROM users WHERE id=$1`, [uid]);
      if (!ok.rowCount) return send(res, 404, { ok: false, error: "USER_NOT_FOUND" });
      await db().query(
        `INSERT INTO user_subscriptions (user_id, plan_code, status, starts_at, expires_at) VALUES ($1,$2,'active',NOW(),NOW() + ($3 || ' days')::interval)`,
        [uid, plan, String(days)]);
      await audit(s.id, "admin.grant", "user", uid, { plan, days });
      return send(res, 200, { ok: true });
    }
    // Telegram channels + scheduled auto-alerts (lib/channels.js)
    if (await channelsAdmin(req, res, path, s, audit, q)) return;
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch { return send(res, 500, { ok: false, error: "ADMIN_FAILED" }); }
}
