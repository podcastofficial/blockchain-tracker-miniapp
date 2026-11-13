// Telegram bot webhook: /start /help /price /alerts. Register with setWebhook + secret_token (see README).
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { j } from "./balances.js";
import { fetchRich, composePost } from "./rich.js";
import { issueLoginCode, prettyCode } from "./loginCode.js";
import { claimUpdate, handleCommunityUpdate, isCommunityChat } from "./community.js";
import { claimDaily, getConfig, utcDay } from "./points.js";
import { attachReferral, REF_RE } from "./referral.js";
import { forceJoinStatus, joinPromptExtra, JOIN_PROMPT_TEXT, missingNames } from "./forcejoin.js";

const tgSend = (chat_id, text, extra = {}) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id, text, disable_web_page_preview: true, ...extra })
}).catch(() => {});
const appButton = () => /^https:\/\//.test(process.env.MINIAPP_URL || "")
  ? { reply_markup: { inline_keyboard: [[{ text: "📊 Open Blockchain Tracker", web_app: { url: process.env.MINIAPP_URL } }]] } } : {};
const tgAnswer = (id, text, alert = false) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text: String(text).slice(0, 190), show_alert: alert })
}).catch(() => {});
const CLAIM_TEXT = { ALREADY_CLAIMED: "You already claimed today's reward. Come back after 00:00 UTC.", DAILY_CAP_REACHED: "Daily points cap reached. Try again after 00:00 UTC.", POINTS_DISABLED: "Points are currently disabled." };

// Creates the account on the very first /start (the Mini App login later reuses it) and links a referral code if /start came with one.
async function ensureUser(from, startArg) {
  const r = await db().query(
    `INSERT INTO users (telegram_user_id, username, first_name, last_name, language_code, is_premium)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (telegram_user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()
     RETURNING id, is_blocked, (xmax = 0) AS inserted`,
    [String(from.id), from.username || null, from.first_name || null, from.last_name || null, from.language_code || null, Boolean(from.is_premium)]);
  const u = r.rows[0];
  if (u.inserted && REF_RE.test(String(startArg || ""))) { try { await attachReferral(u.id, startArg); } catch { /* best-effort */ } }
  return u;
}
// Welcome keyboard: Open app + (if today's login reward is still unclaimed) a claim button.
async function startKeyboard(userId) {
  const rows = [];
  if (/^https:\/\//.test(process.env.MINIAPP_URL || "")) rows.push([{ text: "📊 Open Blockchain Tracker", web_app: { url: process.env.MINIAPP_URL } }]);
  try {
    const cfg = await getConfig();
    if (cfg.enabled && userId) {
      const done = await db().query(`SELECT 1 FROM points_task_claims WHERE user_id=$1 AND task_code='daily_login' AND claim_day=$2`, [userId, utcDay()]);
      if (!done.rowCount) rows.unshift([{ text: `🎁 Claim daily reward (+${cfg.rewards.daily_login.points} MBC Points)`, callback_data: "pts_claim" }]);
    }
  } catch { /* points not migrated yet: no claim button */ }
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {};
}
async function claimFromBot(cq) {
  try {
    const u = await db().query(`SELECT id, is_blocked FROM users WHERE telegram_user_id=$1`, [String(cq.from.id)]);
    if (!u.rowCount || u.rows[0].is_blocked) return tgAnswer(cq.id, "Send /start first.", true);
    const r = await claimDaily(u.rows[0].id, "daily_login");
    return tgAnswer(cq.id, r.ok ? `🎉 +${r.awarded} MBC Points added! Balance: ${r.balance}` : (CLAIM_TEXT[r.error] || "Could not claim right now."), true);
  } catch { return tgAnswer(cq.id, "Could not claim right now. Please try again.", true); }
}
const WELCOME_TEXT = "👋 Blockchain Tracker\nTrack wallets, whales, contracts and prices across 10 chains.\n\n/price btc – live price\n/alerts – your active alerts\n/login – one-time code to sign in from a normal browser";
// "✅ I've Joined" button: re-checks the required channel/group and only then unlocks the Mini App button.
async function joinCheckFromBot(cq) {
  try {
    const st = await forceJoinStatus(cq.from.id, { fresh: true });
    if (st.gateActive && !st.allJoined) return tgAnswer(cq.id, "❌ You have not joined yet: " + missingNames(st.items), true);
    await tgAnswer(cq.id, "✅ Verified! Welcome.");
    const u = await db().query(`SELECT id, is_blocked FROM users WHERE telegram_user_id=$1`, [String(cq.from.id)]);
    const uid = u.rowCount && !u.rows[0].is_blocked ? u.rows[0].id : null;
    return tgSend(cq.message.chat.id, WELCOME_TEXT, await startKeyboard(uid));
  } catch { return tgAnswer(cq.id, "Could not verify right now. Please try again.", true); }
}
const fmt = n => n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(Number(n.toPrecision(4)));

async function price(chat, arg) {
  if (!/^[a-zA-Z0-9 .\-]{1,30}$/.test(arg || "")) return tgSend(chat, "Usage: /price btc");
  try {
    const sr = await j("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(arg));
    const c = sr.coins?.[0]; if (!c) return tgSend(chat, "Coin not found.");
    const [coin] = await fetchRich([c.id]); if (!coin) return tgSend(chat, "Price unavailable right now.");
    const p = await composePost({ title: "📈 <b>Live price</b>", list: [coin], footer: "🕒 " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", media: "chart", buttons: true, priv: true });
    return tgSend(chat, p.text, p.extra);
  } catch { return tgSend(chat, "Price source is busy, try again shortly."); }
}
async function alerts(chat, tgId) {
  const r = await db().query(
    `SELECT u.id,
       (SELECT COUNT(*) FROM price_alerts WHERE user_id=u.id AND status='active')::int AS price,
       (SELECT COUNT(*) FROM onchain_alerts WHERE user_id=u.id AND status='active')::int AS onchain
     FROM users u WHERE u.telegram_user_id=$1`, [String(tgId)]);
  if (!r.rowCount) return tgSend(chat, "Open the Mini App once to create your account.", appButton());
  const a = r.rows[0];
  return tgSend(chat, `🔔 Active alerts\nPrice: ${a.price}\nOn-chain (wallet/whale/contract): ${a.onchain}\n\nManage them inside the Mini App.`, appButton());
}

export async function telegramWebhook(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (secret.length < 16) return send(res, 503, { ok: false, error: "WEBHOOK_NOT_CONFIGURED" });
  const given = Buffer.from(String(req.headers["x-telegram-bot-api-secret-token"] || "")), want = Buffer.from(secret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const upd = req.body || {};
  // Retry-safe: Telegram re-sends unacknowledged updates; process each update_id once (fails open if table missing).
  if (!(await claimUpdate(upd.update_id))) return send(res, 200, { ok: true, duplicate: true });
  // Group / channel traffic and bot-membership changes go to the Community Monitor module.
  if (upd.my_chat_member || upd.channel_post || isCommunityChat((upd.message || {}).chat) || isCommunityChat(upd.callback_query?.message?.chat)) {
    await handleCommunityUpdate(upd);
    return send(res, 200, { ok: true });
  }
  const m = upd.message;
  try {
    if (upd.callback_query?.data === "pts_claim" && upd.callback_query.message?.chat?.type === "private") { await claimFromBot(upd.callback_query); return send(res, 200, { ok: true }); }
    if (upd.callback_query?.data === "fj_check" && upd.callback_query.message?.chat?.type === "private") { await joinCheckFromBot(upd.callback_query); return send(res, 200, { ok: true }); }
    if (m?.text && m.chat?.type === "private") {
      const [raw, ...args] = m.text.trim().split(/\s+/), cmd = raw.split("@")[0].toLowerCase();
      if (cmd === "/start" || cmd === "/help") {
        let uid = null;
        if (cmd === "/start") { try { const u = await ensureUser(m.from, args[0]); if (!u.is_blocked) uid = u.id; } catch { /* account is created at Mini App login anyway */ } }
        if (cmd === "/start") { // compulsory join: show the channel + group first, the Mini App button only appears after joining
          let st = null; try { st = await forceJoinStatus(m.from.id); } catch { /* fail open */ }
          if (st && st.gateActive && !st.allJoined) { await tgSend(m.chat.id, JOIN_PROMPT_TEXT, joinPromptExtra(st.items)); return send(res, 200, { ok: true }); }
        }
        await tgSend(m.chat.id, WELCOME_TEXT, cmd === "/start" ? await startKeyboard(uid) : appButton());
      }
      else if (cmd === "/price") await price(m.chat.id, args.join(" "));
      else if (cmd === "/alerts") await alerts(m.chat.id, m.from.id);
      else if (cmd === "/login") {
        const code = await issueLoginCode(m.from);
        const url = /^https:\/\//.test(process.env.MINIAPP_URL || "") ? process.env.MINIAPP_URL : "";
        await tgSend(m.chat.id, code
          ? `🔐 Your login code: ${prettyCode(code)}\n\nValid for 5 minutes, works once. Open ${url || "the website"} in your browser, go to My Profile and enter it.\nNever share this code with anyone.`
          : "Too many login codes requested. Please try again in an hour.");
      }
    }
  } catch { /* always ack so Telegram does not retry */ }
  return send(res, 200, { ok: true });
}
