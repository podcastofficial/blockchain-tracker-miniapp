// Rich Telegram posts: emoji-style text, 1h / 4h / 8h / 24h change, Chart · Buy · Sell buttons (deep links into the Mini App)
// and a chart / logo image shown above the text. Used by the channel broadcaster (lib/channels.js) and the bot (/price).
import { j } from "./balances.js";

/* ---------------------------------- small helpers ---------------------------------- */
export const h = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // Telegram HTML escape
export const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const fmtPrice = n => { n = Number(n); if (!Number.isFinite(n)) return "—"; return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : 4 }) : String(Number(n.toPrecision(4))); };
const pctVal = (now, then) => (Number.isFinite(now) && Number.isFinite(then) && then > 0 ? (now - then) / then * 100 : null);

/* ---------------------------------- data ---------------------------------- */
// CoinGecko (free) gives 1h/24h/7d directly. 4h and 8h are derived from the hourly 7-day sparkline
// (price N hours ago = sparkline[last - N]), so they are close approximations, not exchange-exact candles.
export async function fetchRich(ids, fetcher = j) {
  ids = [...new Set((ids || []).filter(Boolean))].slice(0, 50);
  if (!ids.length) return [];
  const rows = await fetcher("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=100&sparkline=true&price_change_percentage=1h,24h,7d&ids=" + encodeURIComponent(ids.join(",")));
  const by = new Map((Array.isArray(rows) ? rows : []).map(r => [r.id, r]));
  return ids.map(id => by.get(id)).filter(r => r && Number.isFinite(r.current_price)).map(r => {
    const sp = Array.isArray(r.sparkline_in_7d?.price) ? r.sparkline_in_7d.price.filter(Number.isFinite) : [];
    const back = n => (sp.length > n ? sp[sp.length - 1 - n] : null);
    const p = r.current_price;
    const c24 = Number.isFinite(r.price_change_percentage_24h_in_currency) ? r.price_change_percentage_24h_in_currency : (Number.isFinite(r.price_change_percentage_24h) ? r.price_change_percentage_24h : null);
    return {
      id: r.id, symbol: String(r.symbol || "").toUpperCase(), name: r.name || r.id, image: typeof r.image === "string" && r.image.startsWith("https://") ? r.image : null,
      price: p, rank: r.market_cap_rank ?? null, mcap: r.market_cap ?? null, vol: r.total_volume ?? null, spark: sp,
      c1h: Number.isFinite(r.price_change_percentage_1h_in_currency) ? r.price_change_percentage_1h_in_currency : pctVal(p, back(1)),
      c4h: pctVal(p, back(4)), c8h: pctVal(p, back(8)), c24h: c24 ?? pctVal(p, back(24)),
      c7d: Number.isFinite(r.price_change_percentage_7d_in_currency) ? r.price_change_percentage_7d_in_currency : null
    };
  });
}

/* ---------------------------------- text ---------------------------------- */
export const dot = v => (v === null || v === undefined || !Number.isFinite(v) ? "⚪" : v > 0 ? "🟢" : v < 0 ? "🔴" : "⚪");
export const pct = v => (v === null || v === undefined || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "%");
const mood = v => (!Number.isFinite(v) ? "🪙" : v >= 10 ? "🚀" : v > 0 ? "📈" : v <= -10 ? "💥" : v < 0 ? "📉" : "➖");
const tf = (icon, label, v) => `${icon} ${label} ${dot(v)} <b>${pct(v)}</b>`;

// full card for one coin (4 timeframes on two lines)
export function coinCard(c, extraLine = "") {
  return `${mood(c.c24h)} <b>${h(c.symbol)}</b> · ${h(c.name)}${c.rank ? `  <i>#${c.rank}</i>` : ""}\n` +
    `💰 <b>$${fmtPrice(c.price)}</b>\n` +
    `${tf("🕐", "1h", c.c1h)}   ${tf("🕓", "4h", c.c4h)}\n` +
    `${tf("🕗", "8h", c.c8h)}   ${tf("📆", "24h", c.c24h)}` + (extraLine ? "\n" + extraLine : "");
}
// one-line version for long lists (> 8 coins)
export function coinLine(c) {
  return `${mood(c.c24h)} <b>${h(c.symbol)}</b> $${fmtPrice(c.price)}\n   1h ${dot(c.c1h)}${pct(c.c1h)} · 4h ${dot(c.c4h)}${pct(c.c4h)} · 8h ${dot(c.c8h)}${pct(c.c8h)} · 24h ${dot(c.c24h)}${pct(c.c24h)}`;
}
export const coinBlocks = (list, extra = {}) => (list.length > 8 ? list.map(coinLine) : list.map(c => coinCard(c, extra[c.id] || ""))).join("\n\n");

/* ---------------------------------- Mini App deep links + buttons ---------------------------------- */
// Telegram only allows `web_app` buttons in PRIVATE chats. Channel / group posts must use url buttons, so we use
// direct links:  https://t.me/<bot>/<short_name>?startapp=<param>   (or https://t.me/<bot>?startapp=<param> for the Main Mini App).
// The Mini App reads the param (c_<coinId> = chart, b_<coinId> = buy, s_<coinId> = sell) and opens the right screen.
const okParam = p => /^[A-Za-z0-9_-]{1,64}$/.test(p);
export function deepLink(param) {
  const bot = String(process.env.BOT_USERNAME || "").replace(/^@/, ""), short = process.env.MINIAPP_SHORT_NAME || "";
  if (bot && okParam(param)) return `https://t.me/${bot}${short ? "/" + short : ""}?startapp=${param}`;
  if (bot) return `https://t.me/${bot}${short ? "/" + short : ""}`;
  return null;
}
const appUrl = (act, coin) => { // fallback / private-chat URL (plain query string works inside web_app buttons)
  const u = process.env.MINIAPP_URL || ""; if (!/^https:\/\//.test(u)) return null;
  const q = new URLSearchParams(); if (act) q.set("act", act); if (coin) q.set("coin", coin);
  return u + (u.includes("?") ? "&" : "?") + q.toString();
};
function btn(text, act, coinId, priv) {
  const code = { chart: "c", buy: "b", sell: "s" }[act] || "c";
  if (priv) { const u = appUrl(act, coinId); return u ? { text, web_app: { url: u } } : null; }
  const url = deepLink(coinId ? `${code}_${coinId}` : "home") || appUrl(act, coinId);
  return url ? { text, url } : null;
}
// rows: [📊 BTC Chart][🟢 Buy][🔴 Sell] per coin (max 8 coins) + [📱 Open Mini App]
export function keyboard(list, { priv = false, trade = true } = {}) {
  const rows = [];
  for (const c of list.slice(0, 8)) {
    const row = [btn(`📊 ${c.symbol} Chart`, "chart", c.id, priv)];
    if (trade) row.push(btn("🟢 Buy", "buy", c.id, priv), btn("🔴 Sell", "sell", c.id, priv));
    const clean = row.filter(Boolean); if (clean.length) rows.push(clean);
  }
  const home = btn("📱 Open Mini App", "chart", null, priv);
  if (home) rows.push([home]);
  return rows.length ? { inline_keyboard: rows } : null;
}

/* ---------------------------------- image (chart / logo) ---------------------------------- */
const down = (a, n) => { if (a.length <= n) return a; const out = []; for (let i = 0; i < n; i++) out.push(a[Math.round(i * (a.length - 1) / (n - 1))]); return out; };
const PALETTE = ["#38bdf8", "#f472b6", "#facc15", "#34d399", "#a78bfa", "#fb923c"];

function chartConfig(list) {
  const grid = "rgba(148,163,184,.18)", txt = "#cbd5e1";
  if (list.length === 1) { // single coin: 7d price line + area
    const c = list[0], pts = down(c.spark, 56), up = pts.length > 1 && pts[pts.length - 1] >= pts[0], col = up ? "#22c55e" : "#ef4444";
    return { type: "line", data: { labels: pts.map((_, i) => i), datasets: [{ data: pts.map(v => Number(Number(v).toPrecision(6))), borderColor: col, backgroundColor: up ? "rgba(34,197,94,.18)" : "rgba(239,68,68,.18)", fill: true, borderWidth: 3, pointRadius: 0, tension: 0.3 }] },
      options: { plugins: { legend: { display: false }, title: { display: true, text: `${c.symbol}  $${fmtPrice(c.price)}   24h ${pct(c.c24h)}   7d ${pct(c.c7d)}`, color: "#f8fafc", font: { size: 22, weight: "bold" } }, subtitle: { display: true, text: "7-day price · Blockchain Tracker", color: txt, font: { size: 13 } } },
        scales: { x: { display: false }, y: { ticks: { color: txt, callback: v => "$" + v }, grid: { color: grid } } } } };
  }
  const L = list.slice(0, 6).filter(c => c.spark.length > 24); // several coins: 24h performance, each line starts at 0 %
  return { type: "line", data: { labels: Array.from({ length: 25 }, (_, i) => i), datasets: L.map((c, i) => { const s = c.spark.slice(-25), b = s[0]; return { label: c.symbol, data: s.map(v => Number(((v - b) / b * 100).toFixed(2))), borderColor: PALETTE[i % PALETTE.length], borderWidth: 3, pointRadius: 0, tension: 0.3, fill: false }; }) },
    options: { plugins: { legend: { labels: { color: "#f8fafc", font: { size: 15 } } }, title: { display: true, text: "24h performance (%)", color: "#f8fafc", font: { size: 22, weight: "bold" } }, subtitle: { display: true, text: "Blockchain Tracker", color: txt, font: { size: 13 } } },
      scales: { x: { display: false }, y: { ticks: { color: txt, callback: v => v + "%" }, grid: { color: grid } } } } };
}

// Returns an https image URL Telegram can fetch, or null (then the post is sent without image — never fails the post).
export async function buildImage(list, mode = "chart") {
  if (!list.length || mode === "none") return null;
  if (mode === "logo") return list[0].image || null;
  const usable = list.filter(c => c.spark && c.spark.length > 24);
  if (!usable.length) return list[0].image || null;
  const body = { version: "4", backgroundColor: "#0f172a", width: 900, height: 480, format: "png", chart: chartConfig(usable) };
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch("https://quickchart.io/chart/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }).finally(() => clearTimeout(t));
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.success && /^https:\/\//.test(d.url || "")) return d.url;
  } catch { /* fall through */ }
  return list[0].image || null; // chart service down → coin logo instead
}

/* ---------------------------------- post assembly ---------------------------------- */
// Returns { text (HTML), extra } ready for tgSend(chatId, text, extra)
export async function composePost({ title, list, extraLines = {}, footer = "", media = "chart", buttons = true, priv = false }) {
  let body = coinBlocks(list, extraLines), text = `${title}\n\n${body}${footer ? "\n\n" + footer : ""}`;
  if (text.length > 3900) { // Telegram limit is 4096 characters
    let n = list.length; while (n > 1 && text.length > 3900) { n--; body = coinBlocks(list.slice(0, n), extraLines); text = `${title}\n\n${body}\n\n…and ${list.length - n} more`; }
  }
  const extra = { parse_mode: "HTML" };
  const img = await buildImage(list, media);
  if (img) extra.link_preview_options = { url: img, show_above_text: true, prefer_large_media: true };
  if (buttons) { const kb = keyboard(list, { priv }); if (kb) extra.reply_markup = kb; }
  return { text, extra };
}
