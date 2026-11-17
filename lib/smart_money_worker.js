// GET /api/cron/smart-money  (header: Authorization: Bearer <CRON_SECRET>)
// For users who switched it on: keeps followed Smart Money wallets indexed in the background and sends a Telegram
// message when 2+ followed wallets buy (or sell) the same token within 24h. Informational only, nothing is executed.
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, getBearer } from "./http.js";
import { limitsFor } from "./plans.js";
import { premiumAccess } from "./entitle.js";
import { sendText, appButton } from "./notify.js";
import { refreshPnlCache } from "./pnl.js";
import { ensureSmartMoneySchema, followedWallets, buildSmartMoney } from "./smart_money.js";

const RENOTIFY_MS = 6 * 3600 * 1000, KEEP_MS = 3 * 86400000, MAX_MSGS_PER_RUN = 5, TOTAL_BUDGET_MS = 50000;

function cronOk(req) {
  const secret = process.env.CRON_SECRET || "";
  const given = getBearer(req) || String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const usd = v => v == null ? "n/a" : "$" + Math.round(v).toLocaleString("en-US");
const esc = s => String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

export function signalMessage(s) {
  const buy = s.type === "MULTI_WALLET_ACCUMULATION";
  return `${buy ? "🟢 <b>Smart Money accumulation</b>" : "🔴 <b>Smart Money distribution</b>"}\n` +
    `Token: <b>${esc(s.token)}</b> · ${esc(s.network)}\n` +
    `${s.wallets} followed wallets ${buy ? "bought" : "sold"} in the last 24h (${s.walletNames.map(esc).join(", ")})\n` +
    `Observed volume: ${usd(s.observedVolumeUsd)}\n` +
    `<i>Observed on-chain activity only, not advice or a prediction.</i>`;
}

export async function cronSmartMoney(req, res) {
  if (!cronOk(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const started = Date.now();
  try {
    await ensureSmartMoneySchema();
    const users = (await db().query(
      `SELECT s.user_id, s.auto_refresh, s.alerts, s.notified, u.telegram_user_id
       FROM smart_money_settings s JOIN users u ON u.id=s.user_id
       WHERE (s.auto_refresh OR s.alerts) AND NOT u.is_blocked
       ORDER BY s.last_run_at NULLS FIRST LIMIT 10`)).rows;
    let refreshed = 0, sent = 0, errors = 0, paused = 0;
    for (const u of users) {
      if (Date.now() - started > TOTAL_BUDGET_MS) break;
      try {
        // Plan / trial ended: switch the paid-only features off once and tell the user.
        if (!(await premiumAccess(u.user_id))) {
          await db().query(`UPDATE smart_money_settings SET auto_refresh=FALSE, alerts=FALSE, last_run_at=NOW() WHERE user_id=$1`, [u.user_id]);
          await sendText(u.telegram_user_id, "ℹ️ Smart Money alerts and auto-refresh are paused because your plan or free trial ended. Upgrade in the app to turn them back on.", appButton());
          paused++; continue;
        }
        const lim = await limitsFor(u.user_id).catch(() => ({ wallets: 10 }));
        const wallets = (await followedWallets(u.user_id)).slice(0, lim.wallets).map(w => ({ network: w.network, address: w.address }));
        if (wallets.length) {
          const r = await refreshPnlCache(u.user_id, wallets, { budgetMs: 8000, cacheTtl: 15 * 60 * 1000 });
          refreshed += r.walletStatus.filter(w => w.status === "indexed" || w.status === "no_swaps").length;
        }
        let notified = u.notified && typeof u.notified === "object" ? { ...u.notified } : {};
        if (u.alerts && wallets.length) {
          const { signals } = await buildSmartMoney(u.user_id);
          let msgs = 0;
          for (const sig of signals) {
            if (msgs >= MAX_MSGS_PER_RUN) break;
            const prev = notified[sig.key];
            const isNew = !prev || sig.wallets > prev.wallets || sig.latestAt - prev.at > RENOTIFY_MS;
            if (!isNew) continue;
            if (await sendText(u.telegram_user_id, signalMessage(sig), { parse_mode: "HTML", ...appButton() })) { notified[sig.key] = { at: sig.latestAt, wallets: sig.wallets }; msgs++; sent++; }
          }
        }
        for (const [k, v] of Object.entries(notified)) if (Date.now() - v.at > KEEP_MS) delete notified[k];
        await db().query(`UPDATE smart_money_settings SET last_run_at=NOW(), notified=$2::jsonb WHERE user_id=$1`, [u.user_id, JSON.stringify(notified)]);
      } catch (e) {
        errors++; console.error("[smart-money-cron]", u.user_id, e.message);
        await db().query(`UPDATE smart_money_settings SET last_run_at=NOW() WHERE user_id=$1`, [u.user_id]).catch(() => {});
      }
    }
    return send(res, 200, { ok: true, users: users.length, refreshedWallets: refreshed, alertsSent: sent, paused, errors, ms: Date.now() - started });
  } catch (e) {
    console.error("[smart-money-cron]", e.message);
    return send(res, 500, { ok: false, error: "SMART_MONEY_CRON_FAILED" });
  }
}
