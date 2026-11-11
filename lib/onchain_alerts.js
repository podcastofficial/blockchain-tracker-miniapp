import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed, getBearer } from "./http.js";
import { readSession } from "./session.js";
import { SUPPORTED, validAddr } from "./balances.js";
import { scanRule, WHALE_NETS } from "./onchain.js";

const LIMITS = { free: 3, pro: 20, business: 100, enterprise: 500 };
const MIN_WHALE_USD = 10000;
const EVM_NETS = ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche"];

async function limitFor(uid) {
  const r = await db().query(
    `SELECT plan_code FROM user_subscriptions WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at DESC NULLS FIRST LIMIT 1`, [uid]);
  const plan = r.rows[0]?.plan_code || "free";
  return { plan, limit: LIMITS[plan] ?? LIMITS.free };
}

export async function onchainAlerts(req, res) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  const uid = s.id;
  try {
    if (req.method === "GET") {
      const [rules, events, stats, lim] = await Promise.all([
        db().query(`SELECT id, kind, network, address, min_usd::float8 AS min_usd, status, last_run_at, last_error, created_at
                    FROM onchain_alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [uid]),
        db().query(`SELECT id, kind, network, summary, usd::float8 AS usd, delivery_status, created_at
                    FROM alert_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [uid]),
        db().query(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today,
                           COUNT(*) FILTER (WHERE delivery_status='sent')::int AS sent,
                           COUNT(*) FILTER (WHERE delivery_status='failed')::int AS failed
                    FROM alert_events WHERE user_id=$1`, [uid]),
        limitFor(uid)
      ]);
      return send(res, 200, { ok: true, rules: rules.rows, events: events.rows, stats: stats.rows[0], plan: lim.plan, limit: lim.limit });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const kind = b.kind, network = String(b.network || "").toLowerCase(), minUsd = Number(b.minUsd);
      const address = kind === "wallet" || kind === "contract" ? String(b.address || "").trim() : null;
      const okNet = kind === "whale" ? WHALE_NETS.includes(network) : kind === "contract" ? EVM_NETS.includes(network) : SUPPORTED.includes(network);
      if (!["wallet", "whale", "contract"].includes(kind) || !okNet || !Number.isFinite(minUsd) || minUsd < 0.01 || minUsd > 1e9
        || ((kind === "wallet" || kind === "contract") && !validAddr(network, address)) || (kind === "whale" && minUsd < MIN_WHALE_USD)) {
        return send(res, 400, { ok: false, error: "INVALID_ALERT" });
      }
      const lim = await limitFor(uid);
      const cnt = await db().query(
        `SELECT (SELECT COUNT(*) FROM onchain_alerts WHERE user_id=$1 AND status='active')
              + (SELECT COUNT(*) FROM price_alerts WHERE user_id=$1 AND status='active') AS n`, [uid]);
      if (Number(cnt.rows[0].n) >= lim.limit) return send(res, 403, { ok: false, error: "ALERT_LIMIT_REACHED", limit: lim.limit, plan: lim.plan });
      const ins = await db().query(
        `INSERT INTO onchain_alerts (user_id, kind, network, address, min_usd) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [uid, kind, network, address, String(minUsd)]);
      return send(res, 201, { ok: true, id: ins.rows[0].id });
    }
    if (req.method === "DELETE") {
      const id = Number(new URL(req.url, "https://x.invalid").searchParams.get("id"));
      if (!Number.isSafeInteger(id)) return send(res, 400, { ok: false, error: "INVALID_ID" });
      await db().query(`DELETE FROM onchain_alerts WHERE id=$1 AND user_id=$2`, [id, uid]);
      return send(res, 200, { ok: true });
    }
    return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
  } catch { return send(res, 500, { ok: false, error: "ONCHAIN_ALERTS_FAILED" }); }
}

function cronOk(req) {
  const secret = process.env.CRON_SECRET || "";
  const given = getBearer(req) || String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function telegram(chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    return r.ok;
  } catch { return false; }
}

export async function cronOnchain(req, res) {
  if (!cronOk(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const started = Date.now();
  const rules = (await db().query(
    `SELECT a.id, a.user_id, a.kind, a.network, a.address, a.min_usd::float8 AS min_usd, a.state, u.telegram_user_id
     FROM onchain_alerts a JOIN users u ON u.id=a.user_id
     WHERE a.status='active' AND NOT u.is_blocked
     ORDER BY a.last_run_at NULLS FIRST LIMIT 40`)).rows;
  let events = 0, errors = 0;
  const work = async rule => {
    if (Date.now() - started > 45000) return;
    try {
      const { state, events: ev } = await scanRule(rule);
      for (const e of ev) {
        const ins = await db().query(
          `INSERT INTO alert_events (alert_id, user_id, tx_key, kind, network, summary, usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (alert_id, tx_key) DO NOTHING RETURNING id`,
          [rule.id, rule.user_id, e.key, rule.kind, rule.network, e.summary, String(Math.round(e.usd * 100) / 100)]);
        if (!ins.rowCount) continue;
        events++;
        const ok = await telegram(rule.telegram_user_id, e.summary);
        await db().query(`UPDATE alert_events SET delivery_status=$2 WHERE id=$1`, [ins.rows[0].id, ok ? "sent" : "failed"]);
      }
      await db().query(`UPDATE onchain_alerts SET state=$2, last_run_at=NOW(), last_error=NULL WHERE id=$1`, [rule.id, JSON.stringify(state)]);
    } catch (err) {
      errors++;
      await db().query(`UPDATE onchain_alerts SET last_run_at=NOW(), last_error=$2 WHERE id=$1`, [rule.id, String(err.message || "SCAN_FAILED").slice(0, 80)]).catch(() => {});
    }
  };
  for (let i = 0; i < rules.length; i += 5) await Promise.all(rules.slice(i, i + 5).map(work));
  return send(res, 200, { ok: true, rules: rules.length, events, errors });
}
