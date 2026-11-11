// Telegram bot webhook: /start /help /price /alerts. Register with setWebhook + secret_token (see README).
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { j } from "./balances.js";

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
    const s = await j("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(arg));
    const c = s.coins?.[0]; if (!c) return tgSend(chat, "Coin not found.");
    const p = (await j(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(c.id)}&vs_currencies=usd&include_24hr_change=true`))[c.id];
    if (!p) return tgSend(chat, "Price unavailable right now.");
    const ch = p.usd_24h_change;
    return tgSend(chat, `${c.name} (${String(c.symbol).toUpperCase()})\n$${fmt(p.usd)}${Number.isFinite(ch) ? `  ${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch).toFixed(2)}% (24h)` : ""}`);
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
        await tgSend(m.chat.id, "👋 Blockchain Tracker\nTrack wallets, whales, contracts and prices across 10 chains.\n\n/price btc – live price\n/alerts – your active alerts", appButton());
      else if (cmd === "/price") await price(m.chat.id, args.join(" "));
      else if (cmd === "/alerts") await alerts(m.chat.id, m.from.id);
    }
  } catch { /* always ack so Telegram does not retry */ }
  return send(res, 200, { ok: true });
}
