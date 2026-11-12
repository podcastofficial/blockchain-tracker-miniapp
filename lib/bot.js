// Telegram bot webhook: /start /help /price /alerts. Register with setWebhook + secret_token (see README).
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { j } from "./balances.js";
import { fetchRich, composePost } from "./rich.js";
import { issueLoginCode, prettyCode } from "./loginCode.js";

const tgSend = (chat_id, text, extra = {}) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id, text, disable_web_page_preview: true, ...extra })
}).catch(() => {});
const appButton = () => /^https:\/\//.test(process.env.MINIAPP_URL || "")
  ? { reply_markup: { inline_keyboard: [[{ text: "📊 Open Blockchain Tracker", web_app: { url: process.env.MINIAPP_URL } }]] } } : {};
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
  const m = req.body?.message;
  try {
    if (m?.text && m.chat?.type === "private") {
      const [raw, ...args] = m.text.trim().split(/\s+/), cmd = raw.split("@")[0].toLowerCase();
      if (cmd === "/start" || cmd === "/help")
        await tgSend(m.chat.id, "👋 Blockchain Tracker\nTrack wallets, whales, contracts and prices across 10 chains.\n\n/price btc – live price\n/alerts – your active alerts\n/login – one-time code to sign in from a normal browser", appButton());
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
