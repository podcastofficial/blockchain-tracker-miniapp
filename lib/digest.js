// Daily Telegram digest: which followed wallets are in profit, new Smart Money signals, today's biggest moves, portfolio change.
//   GET/POST /api/digest/settings   { enabled?: boolean, hourUtc?: 0-23 }   (turning it ON needs a paid plan or free trial)
//   POST     /api/digest/send-now   sends today's digest immediately (preview)
//   GET      /api/cron/digest       (Authorization: Bearer CRON_SECRET)  sent from the 5-minute GitHub worker
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed, getBearer } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { premiumAccess } from "./entitle.js";
import { sendText, appButton } from "./notify.js";
import { computePnl } from "./pnl_engine.js";
import { limitsFor } from "./plans.js";
import { refreshPnlCache } from "./pnl.js";
import { followedWallets, buildSmartMoney } from "./smart_money.js";
import { trackUsage } from "./usage.js";

const DAY = 86400000;
let schemaP;
const ensure = () => schemaP || (schemaP = db().query(`CREATE TABLE IF NOT EXISTS digest_settings (
  user_id BIGINT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE, hour_utc SMALLINT NOT NULL DEFAULT 8, last_sent_on DATE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
  .catch(e => { schemaP = null; throw e; }));

const esc = s => String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const usd = v => (v == null || !Number.isFinite(v) ? "n/a" : (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US"));
const usdPlain = v => "$" + Math.round(v).toLocaleString("en-US");
const cronOk = req => {
  const secret = process.env.CRON_SECRET || "", given = getBearer(req) || String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Builds the digest message for one user from indexed history (no extra API calls).
export async function buildDigest(uid) {
  const followed = await followedWallets(uid);
  const now = Date.now();
  let cache = [];
  try { cache = (await db().query(`SELECT network, address, trades, updated_at FROM pnl_cache WHERE user_id=$1`, [uid])).rows; } catch { /* not indexed yet */ }
  const by = new Map(cache.map(r => [`${r.network}:${String(r.address).toLowerCase()}`, r]));
  const rows = followed.map(w => {
    const r = by.get(`${w.network}:${String(w.address).toLowerCase()}`), trades = Array.isArray(r?.trades) ? r.trades : [];
    const p = computePnl(trades, { sinceTs: now - DAY, marks: {} });
    return { name: w.name, network: w.network, real24: p.summary.realizedUsd, closed24: p.summary.closedTrades, swaps24: p.summary.trades, trades, updatedAt: r?.updated_at ? new Date(r.updated_at).getTime() : 0 };
  });
  const active = rows.filter(r => r.swaps24 > 0), inProfit = rows.filter(r => r.real24 > 0.5).sort((a, b) => b.real24 - a.real24), inLoss = rows.filter(r => r.real24 < -0.5).sort((a, b) => a.real24 - b.real24);
  const moves = rows.flatMap(r => r.trades.filter(t => t.ts >= now - DAY).map(t => ({ ...t, name: r.name }))).sort((a, b) => b.usdValue - a.usdValue).slice(0, 5);
  let signals = [];
  try { signals = (await buildSmartMoney(uid)).signals.slice(0, 4); } catch { /* optional */ }
  let pf = null;
  try {
    const a = (await db().query(`SELECT total_usd::float8 AS v FROM portfolio_snapshots WHERE user_id=$1 ORDER BY taken_at DESC LIMIT 1`, [uid])).rows[0];
    const b = (await db().query(`SELECT total_usd::float8 AS v FROM portfolio_snapshots WHERE user_id=$1 AND taken_at < NOW() - INTERVAL '20 hours' ORDER BY taken_at DESC LIMIT 1`, [uid])).rows[0];
    if (a) pf = { now: a.v, delta: b ? a.v - b.v : null };
  } catch { /* snapshots optional */ }
  const L = [`☀️ <b>Daily digest</b> · ${new Date().toISOString().slice(0, 10)}`];
  if (!followed.length) L.push("", "You are not following any Smart Money wallets yet. Add wallets with the Smart Money category, or use Discover on a token.");
  else {
    const net = rows.reduce((a, r) => a + r.real24, 0);
    L.push("", `<b>Smart Money</b> · ${followed.length} wallets · ${active.length} active in 24h`, `Realized PnL (24h, closed trades): <b>${usd(net)}</b>`);
    if (inProfit.length) L.push("🟢 In profit: " + inProfit.slice(0, 3).map(r => `${esc(r.name)} ${usd(r.real24)}`).join(", "));
    if (inLoss.length) L.push("🔴 In loss: " + inLoss.slice(0, 2).map(r => `${esc(r.name)} ${usd(r.real24)}`).join(", "));
    if (!inProfit.length && !inLoss.length) L.push(active.length ? "No closed trades in the last 24h, so no realized profit or loss yet." : "No swaps from your wallets in the last 24h.");
    if (signals.length) { L.push("", "<b>New signals</b>"); for (const s of signals) L.push(`${s.type === "MULTI_WALLET_ACCUMULATION" ? "🟢 Buy" : "🔴 Sell"} ${esc(s.token)} (${esc(s.network)}) · ${s.wallets} wallets · ${usdPlain(s.observedVolumeUsd || 0)}`); }
    if (moves.length) { L.push("", "<b>Biggest moves (24h)</b>"); for (const m of moves) L.push(`${m.side === "buy" ? "🟢" : "🔴"} ${esc(m.name)} ${m.side} ${esc(m.token?.symbol)} · ${usdPlain(m.usdValue)}`); }
    const oldest = Math.min(...rows.map(r => r.updatedAt || 0));
    if (oldest && now - oldest > DAY) L.push("", "<i>Some wallet data is older than 24h. Turn on Smart Money auto-refresh to keep it current.</i>");
    else if (rows.some(r => !r.updatedAt)) L.push("", "<i>Some wallets are not indexed yet. Open Smart Money and tap Analyze.</i>");
  }
  if (pf) L.push("", `<b>Portfolio</b>: ${usdPlain(pf.now)}${pf.delta != null ? ` (${usd(pf.delta)} vs yesterday)` : ""}`);
  L.push("", "<i>Observed on-chain data only, not advice.</i>");
  return L.join("\n");
}

export async function digestApi(req, res, path) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "digest", s.id, 12)) return;
  try {
    await ensure();
    if (path === "/api/digest/send-now") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (!(await premiumAccess(s.id))) return send(res, 402, { ok: false, error: "PLAN_REQUIRED", feature: "digest" });
      const ok = await sendText(s.telegram_user_id, await buildDigest(s.id), { parse_mode: "HTML", ...appButton() });
      trackUsage(s.id, "digest_preview");
      return ok ? send(res, 200, { ok: true }) : send(res, 502, { ok: false, error: "TELEGRAM_DELIVERY_FAILED" });
    }
    if (req.method === "POST") {
      let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } } b = b || {};
      const cur = (await db().query(`SELECT enabled, hour_utc FROM digest_settings WHERE user_id=$1`, [s.id])).rows[0] || { enabled: false, hour_utc: 8 };
      const enabled = typeof b.enabled === "boolean" ? b.enabled : cur.enabled;
      const hour = Number.isInteger(b.hourUtc) && b.hourUtc >= 0 && b.hourUtc <= 23 ? b.hourUtc : cur.hour_utc;
      if (enabled && !cur.enabled && !(await premiumAccess(s.id))) return send(res, 402, { ok: false, error: "PLAN_REQUIRED", feature: "digest", hint: "Start the free trial or upgrade to get the daily digest." });
      await db().query(`INSERT INTO digest_settings(user_id, enabled, hour_utc) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled, hour_utc=EXCLUDED.hour_utc, updated_at=NOW()`, [s.id, enabled, hour]);
      trackUsage(s.id, "digest_settings");
      return send(res, 200, { ok: true, enabled, hourUtc: hour });
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "POST"]);
    const r = (await db().query(`SELECT enabled, hour_utc, last_sent_on FROM digest_settings WHERE user_id=$1`, [s.id])).rows[0];
    return send(res, 200, { ok: true, enabled: !!r?.enabled, hourUtc: r?.hour_utc ?? 8, lastSentOn: r?.last_sent_on || null, premium: await premiumAccess(s.id) });
  } catch (e) { console.error("[digest]", e.message); return send(res, 500, { ok: false, error: "DIGEST_FAILED" }); }
}

export async function cronDigest(req, res) {
  if (!cronOk(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const started = Date.now();
  try {
    await ensure();
    const hour = new Date().getUTCHours();
    // Due = chosen hour already reached today (catch-up window 6h in case a cron run was skipped) and not yet sent today.
    const users = (await db().query(
      `SELECT d.user_id, u.telegram_user_id FROM digest_settings d JOIN users u ON u.id=d.user_id
       WHERE d.enabled AND NOT u.is_blocked AND (d.last_sent_on IS NULL OR d.last_sent_on < (NOW() AT TIME ZONE 'UTC')::date)
         AND ((d.hour_utc <= $1 AND $1 - d.hour_utc < 6) OR (d.hour_utc > $1 AND d.hour_utc - $1 > 18))
       ORDER BY d.last_sent_on NULLS FIRST LIMIT 15`, [hour])).rows;
    let sent = 0, skipped = 0, errors = 0;
    for (const u of users) {
      if (Date.now() - started > 45000) break;
      try {
        if (!(await premiumAccess(u.user_id))) {   // plan / trial ended: stop quietly
          await db().query(`UPDATE digest_settings SET enabled=FALSE, updated_at=NOW() WHERE user_id=$1`, [u.user_id]); skipped++; continue;
        }
        const lim = await limitsFor(u.user_id).catch(() => ({ wallets: 10 }));
        const wallets = (await followedWallets(u.user_id)).slice(0, lim.wallets).map(w => ({ network: w.network, address: w.address }));
        if (wallets.length) await refreshPnlCache(u.user_id, wallets, { budgetMs: 6000, cacheTtl: 30 * 60 * 1000 }).catch(() => {});
        const ok = await sendText(u.telegram_user_id, await buildDigest(u.user_id), { parse_mode: "HTML", ...appButton() });
        if (ok) { sent++; trackUsage(u.user_id, "digest_sent"); }
        // Mark as handled even when Telegram refused (user blocked the bot): avoids retrying every 5 minutes all day.
        await db().query(`UPDATE digest_settings SET last_sent_on=(NOW() AT TIME ZONE 'UTC')::date WHERE user_id=$1`, [u.user_id]);
      } catch (e) { errors++; console.error("[digest-cron]", u.user_id, e.message); }
    }
    return send(res, 200, { ok: true, due: users.length, sent, skipped, errors, ms: Date.now() - started });
  } catch (e) { console.error("[digest-cron]", e.message); return send(res, 500, { ok: false, error: "DIGEST_CRON_FAILED" }); }
}
