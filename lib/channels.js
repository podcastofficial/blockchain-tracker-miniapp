// Telegram channel broadcaster: unlimited channels per blockchain, each with any number of scheduled auto-alert rules.
// Admin API (called from lib/admin.js) + worker (GET /api/cron/channels, run every 5 min by .github/workflows/cron.yml).
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed, getBearer } from "./http.js";
import { EVM, j, validAddr } from "./balances.js";
import { WHALE_NETS, scanRule } from "./onchain.js";
import { trending, movers } from "./market.js";
import { H, NET_EMOJI, renderKey, renderTemplate, tplText, loadTemplates } from "./templates.js";
import { fetchRich, composePost, buildImage, keyboard, stripTags, h, fmtPrice as rFmt, pct as rPct, dot } from "./rich.js";

export const NETWORKS = ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche", "tron", "solana", "ton"];
export const TYPES = ["price", "new_token", "liquidity", "whale", "movers", "trending"];
const NET_NAME = { ethereum: "Ethereum", bsc: "BNB Chain", polygon: "Polygon", arbitrum: "Arbitrum", base: "Base", optimism: "Optimism", avalanche: "Avalanche", tron: "Tron", solana: "Solana", ton: "TON" };
const NATIVE_COIN = { ethereum: "ethereum", bsc: "binancecoin", polygon: "matic-network", arbitrum: "ethereum", base: "ethereum", optimism: "ethereum", avalanche: "avalanche-2", tron: "tron", solana: "solana", ton: "the-open-network" };
const label = n => (n === "all" ? "Crypto" : NET_NAME[n] || n);

/* ---------------------------------- helpers ---------------------------------- */
const int = (v, min, max, def) => { if (v === undefined || v === null || v === "") return def; const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : NaN; };
const num = (v, min, max, def) => { if (v === undefined || v === null || v === "") return def; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : NaN; };
const fmtPrice = n => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(Number(Number(n).toPrecision(4))));
const fmtBig = n => { n = Number(n); if (!Number.isFinite(n)) return "—"; const a = Math.abs(n); return "$" + (a >= 1e9 ? (n / 1e9).toFixed(2) + "B" : a >= 1e6 ? (n / 1e6).toFixed(2) + "M" : a >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(2)); };
const arrow = c => (c >= 0 ? "▲" : "▼") + " " + Math.abs(c).toFixed(2) + "%";
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normAddr = (chain, a) => (EVM[chain] ? String(a).toLowerCase() : String(a));

let TPL = {};                                     // admin-edited alert texts, loaded at the start of every rule run (lib/templates.js)
const tpl = (key, vars) => renderKey(key, vars, TPL);
const linkH = (url, text) => (url ? H(`<a href="${String(url).replace(/"/g, "&quot;")}">${h(text)}</a>`) : "");

const memo = new Map();
export const clearCache = () => memo.clear();
function getJ(url, ttl = 90000) { // de-duplicates identical upstream calls made by several channels in the same run
  const c = memo.get(url);
  if (c && Date.now() - c.t < ttl) return c.p;
  const p = j(url);
  memo.set(url, { t: Date.now(), p });
  p.catch(() => memo.delete(url));
  if (memo.size > 200) for (const [k, v] of memo) if (Date.now() - v.t > ttl) memo.delete(k);
  return p;
}

export function normalizeChat(input) {
  let s = String(input || "").trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/\/.*$/, "");
  if (/^-?\d{5,20}$/.test(s)) return s;
  s = s.replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s) ? "@" + s : null;
}

/* ---------------------------------- telegram ---------------------------------- */
const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || "";
async function tg(method, body, timeout = 10000) {
  if (!tgToken()) return { ok: false, error: "BOT_TOKEN_MISSING" };
  const c = new AbortController(), t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(`https://api.telegram.org/bot${tgToken()}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: c.signal });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) return { ok: true, result: d.result };
    return { ok: false, error: String(d.description || "TELEGRAM_" + r.status).slice(0, 140), retryAfter: d.parameters?.retry_after };
  } catch { return { ok: false, error: "TELEGRAM_UNREACHABLE" }; } finally { clearTimeout(t); }
}
// extra: { parse_mode, reply_markup, link_preview_options } (see lib/rich.js). Falls back to plain text if Telegram rejects the HTML / image.
export async function tgSend(chatId, text, extra = {}) {
  const payload = (t, e) => ({ chat_id: chatId, text: String(t).slice(0, 4000), ...(e.link_preview_options ? {} : { disable_web_page_preview: true }), ...e });
  let r = await tg("sendMessage", payload(text, extra));
  if (!r.ok && r.retryAfter && r.retryAfter <= 8) { await sleep(r.retryAfter * 1000 + 200); r = await tg("sendMessage", payload(text, extra)); }
  if (!r.ok && /parse entities|can't parse|BUTTON|button|link preview|preview/i.test(r.error || "")) { // retry once with the safest variant (still keeps buttons when they are valid)
    const { parse_mode, link_preview_options, ...rest } = extra;
    r = await tg("sendMessage", payload(parse_mode ? stripTags(text) : text, rest));
    if (!r.ok && rest.reply_markup) { const { reply_markup, ...bare } = rest; r = await tg("sendMessage", payload(parse_mode ? stripTags(text) : text, bare)); }
  }
  return r;
}
let botId = null;
async function verifyChannel(chat) { // resolves the chat and checks that the bot may post there
  const info = await tg("getChat", { chat_id: chat });
  if (!info.ok) return { error: "CHANNEL_NOT_FOUND", detail: info.error };
  if (!botId) { const me = await tg("getMe", {}); if (me.ok) botId = me.result.id; }
  if (botId) {
    const m = await tg("getChatMember", { chat_id: info.result.id, user_id: botId });
    if (!m.ok) return { error: "BOT_NOT_IN_CHANNEL", detail: m.error };
    const st = m.result.status;
    if (info.result.type === "channel" && !["administrator", "creator"].includes(st)) return { error: "BOT_NOT_ADMIN" };
    if (st === "administrator" && m.result.can_post_messages === false && info.result.type === "channel") return { error: "BOT_CANNOT_POST" };
    if (["left", "kicked"].includes(st)) return { error: "BOT_NOT_IN_CHANNEL" };
  }
  return { id: String(info.result.id), title: info.result.title || info.result.username || String(info.result.id), type: info.result.type };
}

/* ---------------------------------- schedule ---------------------------------- */
function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}
const hhmm = s => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function isDue(rule, now = new Date()) {
  const last = rule.last_run_at ? new Date(rule.last_run_at) : null;
  if (rule.schedule_type === "daily") {
    const target = hhmm(rule.daily_time); if (target === null) return false;
    const n = localParts(now, rule.tz);
    if (n.mins < target) return false;
    return !last || localParts(last, rule.tz).day !== n.day;
  }
  return !last || now - last >= rule.interval_min * 60000 - 90000; // 90s tolerance for cron jitter
}

/* ---------------------------------- alert builders ---------------------------------- */
// Each returns { text: string|null, state }. text === null means "nothing to post this time".
const rich = ids => fetchRich(ids, u => getJ(u, 60000));
const mediaOf = cfg => (["chart", "logo", "none"].includes(cfg.media) ? cfg.media : "chart");
async function buildPrice(rule, ch, state, force) {
  const cfg = rule.config || {};
  let ids = Array.isArray(cfg.coins) ? cfg.coins : [];
  if (!ids.length && NATIVE_COIN[ch.network]) ids = [NATIVE_COIN[ch.network]];
  if (!ids.length) throw new Error("NO_COINS");
  const list = await rich(ids);
  if (!list.length) throw new Error("COINS_NOT_FOUND");
  const opts = { media: mediaOf(cfg), buttons: cfg.buttons !== false };
  if (cfg.mode === "change" && !force) {
    const last = { ...(state.last || {}) }, hit = [], extraLines = {};
    for (const r of list) {
      const prev = last[r.id];
      if (!(prev > 0)) { last[r.id] = r.price; continue; }
      const ch2 = (r.price - prev) / prev * 100;
      if (Math.abs(ch2) >= (cfg.minChangePct || 2)) { hit.push(r); extraLines[r.id] = `🔔 Since last alert: $${rFmt(prev)} → <b>$${rFmt(r.price)}</b> ${dot(ch2)} <b>${rPct(ch2)}</b>`; last[r.id] = r.price; }
    }
    if (!hit.length) return { text: null, state: { ...state, last } };
    const p = await composePost({ title: `🚨 <b>${h(label(ch.network))} price move</b>`, list: hit, extraLines, footer: `🕒 ${stamp()}`, template: tplText(TPL, "price_move"), vars: { network: label(ch.network), time: stamp() }, ...opts });
    return { text: p.text, extra: p.extra, state: { ...state, last } };
  }
  const last = { ...(state.last || {}) }; for (const r of list) last[r.id] = r.price;
  const p = await composePost({ title: `📈 <b>${h(label(ch.network))} price update</b>`, list, footer: `🕒 ${stamp()}`, template: tplText(TPL, "price_update"), vars: { network: label(ch.network), time: stamp() }, ...opts });
  return { text: p.text, extra: p.extra, state: { ...state, last } };
}

async function buildMovers(rule) {
  const cfg = rule.config || {}, top = cfg.top || 5, m = await movers();
  const g = m.gainers.slice(0, top), l = m.losers.slice(0, top);
  const list = await rich([...g, ...l].map(x => x.id));
  const byId = new Map(list.map(x => [x.id, x]));
  const G = g.map(x => byId.get(x.id)).filter(Boolean), L = l.map(x => byId.get(x.id)).filter(Boolean);
  const opts = { media: mediaOf(cfg), buttons: cfg.buttons !== false };
  // two compact sections (one line per coin keeps 10 coins inside Telegram's 4096-character limit)
  const lines = c => `${dot(c.c24h)} <b>${h(c.symbol)}</b> $${rFmt(c.price)}\n   1h ${rPct(c.c1h)} · 4h ${rPct(c.c4h)} · 8h ${rPct(c.c8h)} · 24h <b>${rPct(c.c24h)}</b>`;
  const text = tpl("movers", { gainers: H(G.map(lines).join("\n")), losers: H(L.map(lines).join("\n")), time: stamp() });
  const extra = { parse_mode: "HTML" };
  const img = await buildImage([...G.slice(0, 3), ...L.slice(0, 3)], opts.media); // 3 best + 3 worst on one chart
  if (img) extra.link_preview_options = { url: img, show_above_text: true, prefer_large_media: true };
  if (opts.buttons) { const kb = keyboard([...G.slice(0, 3), ...L.slice(0, 2)]); if (kb) extra.reply_markup = kb; }
  return { text, extra, state: rule.state || {} };
}
async function buildTrending(rule) {
  const cfg = rule.config || {}, top = cfg.top || 7, t = await trending();
  if (!t.length) throw new Error("NO_TRENDING_DATA");
  const list = await rich(t.slice(0, top).map(x => x.id));
  if (!list.length) throw new Error("NO_TRENDING_DATA");
  const p = await composePost({ title: "🔥 <b>Trending coins</b>", list, footer: `🕒 ${stamp()}`, template: tplText(TPL, "trending"), vars: { time: stamp() }, media: mediaOf(cfg), buttons: cfg.buttons !== false });
  return { text: p.text, extra: p.extra, state: rule.state || {} };
}

const dexPairs = async (chain, addrs) => {
  const d = await getJ(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${addrs.map(encodeURIComponent).join(",")}`, 45000);
  return Array.isArray(d) ? d : [];
};
async function buildNewToken(rule, ch, state) {
  const cfg = rule.config || {}, maxAge = (cfg.maxAgeHours || 24) * 3600e3, minLiq = cfg.minLiquidityUsd ?? 5000, maxPer = cfg.maxPerRun || 3;
  const chains = ch.network === "all" ? NETWORKS : [ch.network];
  const raw = await getJ("https://api.dexscreener.com/token-profiles/latest/v1", 60000);
  const seen = new Set(state.seen || []);
  const cands = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(x => x && chains.includes(x.chainId) && x.tokenAddress && !seen.has(x.chainId + ":" + normAddr(x.chainId, x.tokenAddress))).slice(0, 30);
  const found = [];
  const byChain = {}; for (const x of cands) (byChain[x.chainId] ||= []).push(x.tokenAddress);
  for (const [chain, addrs] of Object.entries(byChain)) {
    const pairs = await dexPairs(chain, addrs.slice(0, 30));
    for (const a of addrs) {
      const mine = pairs.filter(p => normAddr(chain, p.baseToken?.address || "") === normAddr(chain, a));
      const best = mine.sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
      const key = chain + ":" + normAddr(chain, a);
      if (!best) continue;                                   // no market yet: look again next run
      const age = best.pairCreatedAt ? Date.now() - best.pairCreatedAt : Infinity;
      if (age > maxAge) { seen.add(key); continue; }         // old token: never interesting
      if ((best.liquidity?.usd || 0) < minLiq) continue;     // too little liquidity: re-check later
      seen.add(key);
      found.push({ chain, best, age });
    }
  }
  found.sort((a, b) => (b.best.liquidity?.usd || 0) - (a.best.liquidity?.usd || 0));
  const out = found.slice(0, maxPer).map(({ chain, best, age }) => {
    const mins = Math.round(age / 60000), when = mins < 90 ? mins + " min ago" : Math.round(mins / 60) + " h ago";
    return tpl("new_token", { network: label(chain), net_emoji: NET_EMOJI[chain] || "🌐", name: best.baseToken?.name || "?", symbol: best.baseToken?.symbol || "", price: best.priceUsd ? "$" + fmtPrice(Number(best.priceUsd)) : "—",
      liquidity: fmtBig(best.liquidity?.usd), fdv: best.fdv ? fmtBig(best.fdv) : "", age: when, link: linkH(best.url, "DEX Screener") });
  });
  return { text: out.length ? `${out.join("\n\n")}\n\n${tpl("new_token_footer", {})}` : null, extra: { parse_mode: "HTML" }, state: { ...state, seen: [...seen].slice(-500) } };
}

async function buildLiquidity(rule, ch, state) {
  const cfg = rule.config || {}, tokens = cfg.tokens || [], liq = { ...(state.liq || {}) }, low = { ...(state.low || {}) }, msgs = [];
  const byChain = {}; for (const t of tokens) (byChain[t.chain] ||= []).push(t);
  for (const [chain, list] of Object.entries(byChain)) {
    const pairs = await dexPairs(chain, list.map(t => t.address).slice(0, 30));
    for (const t of list) {
      const key = chain + ":" + normAddr(chain, t.address), mine = pairs.filter(p => normAddr(chain, p.baseToken?.address || "") === normAddr(chain, t.address));
      const cur = mine.reduce((s, p) => s + (p.liquidity?.usd || 0), 0), prev = liq[key], sym = mine[0]?.baseToken?.symbol || t.label || short(t.address);
      const name = (t.label ? t.label + " " : "") + `(${sym}) on ${label(chain)}`, link = linkH(mine[0]?.url, "DEX Screener");
      const post = (headline, detail) => msgs.push(tpl("liquidity", { headline, token: name, detail, link, time: stamp() }));
      liq[key] = cur;
      if (!(prev >= 0) || prev === undefined) continue; // first measurement = baseline
      if (prev > 0) {
        const chg = (cur - prev) / prev * 100;
        if (-chg >= (cfg.dropPct || 20)) post(-chg >= 70 ? "🚨 LIQUIDITY REMOVED" : "⚠️ Liquidity drop", `${fmtBig(prev)} → ${fmtBig(cur)}  (${chg.toFixed(1)}%)`);
        else if (cfg.risePct > 0 && chg >= cfg.risePct) post("💧 Liquidity added", `${fmtBig(prev)} → ${fmtBig(cur)}  (+${chg.toFixed(1)}%)`);
      }
      if (cfg.minLiquidityUsd > 0) {
        if (cur < cfg.minLiquidityUsd && !low[key]) { low[key] = 1; post("🔻 Low liquidity", `Now ${fmtBig(cur)} (limit ${fmtBig(cfg.minLiquidityUsd)})`); }
        else if (cur >= cfg.minLiquidityUsd) delete low[key];
      }
    }
  }
  return { text: msgs.length ? msgs.join("\n\n") : null, extra: { parse_mode: "HTML" }, state: { ...state, liq, low } };
}

async function buildWhale(rule, ch, state) {
  const cfg = rule.config || {}, nets = ch.network === "all" ? WHALE_NETS : [ch.network];
  if (!nets.every(n => WHALE_NETS.includes(n))) throw new Error("WHALE_NETWORK_UNSUPPORTED");
  const next = { ...state }, msgs = [];
  for (const net of nets) {
    const r = await scanRule({ kind: "whale", network: net, min_usd: cfg.minUsd || 100000, state: state[net] || {} });
    next[net] = r.state; msgs.push(...r.events.map(e => e.html || h(e.summary)));
  }
  return { text: msgs.length ? msgs.slice(0, cfg.maxPerRun || 5).join("\n\n") : null, extra: { parse_mode: "HTML" }, state: next };
}
const short = a => (String(a).length > 14 ? String(a).slice(0, 6) + "…" + String(a).slice(-4) : String(a));

const BUILDERS = { price: buildPrice, movers: buildMovers, trending: buildTrending, new_token: buildNewToken, liquidity: buildLiquidity, whale: buildWhale };

/* ---------------------------------- run one rule ---------------------------------- */
async function execRule(rule, ch, force = false) {
  let built;
  TPL = await loadTemplates();
  try { built = await BUILDERS[rule.alert_type](rule, ch, rule.state || {}, force); }
  catch (e) {
    const err = String(e.message || "BUILD_FAILED").slice(0, 120);
    await db().query(`UPDATE channel_rules SET last_run_at=NOW(), last_error=$2 WHERE id=$1`, [rule.id, err]).catch(() => {});
    return { ok: false, error: err };
  }
  let posted = false, error = null;
  if (built.text) {
    const r = await tgSend(ch.chat_id, built.text, built.extra || {});
    posted = r.ok; error = r.ok ? null : r.error;
    await db().query(`INSERT INTO channel_post_log (channel_id, rule_id, alert_type, status, summary, error) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ch.id, rule.id, rule.alert_type, r.ok ? "sent" : "failed", stripTags(built.text).slice(0, 500), error]).catch(() => {});
    await db().query(r.ok ? `UPDATE broadcast_channels SET last_error=NULL, last_posted_at=NOW() WHERE id=$1` : `UPDATE broadcast_channels SET last_error=$2 WHERE id=$1`,
      r.ok ? [ch.id] : [ch.id, error]).catch(() => {});
  }
  // keep state only when delivery worked (or nothing needed delivery) so a failed post is retried with the same events
  const keep = !built.text || posted;
  await db().query(`UPDATE channel_rules SET state=$2, last_run_at=NOW(), last_error=$3${posted ? ", last_posted_at=NOW()" : ""} WHERE id=$1`,
    [rule.id, JSON.stringify(keep ? built.state : rule.state || {}), error]).catch(() => {});
  return { ok: !error, posted, error, preview: built.text ? stripTags(built.text).slice(0, 300) : null };
}

/* ---------------------------------- cron worker ---------------------------------- */
function cronOk(req) {
  const secret = process.env.CRON_SECRET || "", given = getBearer(req) || String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
export async function cronChannels(req, res) {
  if (!cronOk(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const started = Date.now();
  try {
    const rows = (await db().query(
      `SELECT r.id, r.channel_id, r.alert_type, r.schedule_type, r.interval_min, r.daily_time, r.tz, r.config, r.state, r.last_run_at,
              c.id AS cid, c.chat_id, c.network, c.name
       FROM channel_rules r JOIN broadcast_channels c ON c.id=r.channel_id
       WHERE r.enabled AND c.enabled ORDER BY r.last_run_at NULLS FIRST LIMIT 300`)).rows;
    const due = rows.filter(r => isDue(r)).slice(0, 30);
    let posted = 0, failed = 0;
    const work = async r => {
      if (Date.now() - started > 45000) return;
      const claim = await db().query(`UPDATE channel_rules SET last_run_at=NOW() WHERE id=$1 AND date_trunc('milliseconds', last_run_at) IS NOT DISTINCT FROM $2::timestamptz RETURNING id`, [r.id, r.last_run_at]);
      if (!claim.rowCount) return; // another worker took it
      const out = await execRule(r, { id: r.cid, chat_id: r.chat_id, network: r.network, name: r.name });
      if (out.posted) posted++; else if (out.error) failed++;
    };
    for (let i = 0; i < due.length; i += 3) await Promise.all(due.slice(i, i + 3).map(work));
    await db().query(`DELETE FROM channel_post_log WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => {});
    return send(res, 200, { ok: true, rules: rows.length, due: due.length, posted, failed });
  } catch (e) { return send(res, e && e.code === "42P01" ? 503 : 500, { ok: false, error: e && e.code === "42P01" ? "CHANNELS_NOT_MIGRATED" : "CHANNELS_CRON_FAILED" }); }
}

/* ---------------------------------- rule validation ---------------------------------- */
const parseList = v => (Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
// image above the post: chart (default) | logo | none;  Chart/Buy/Sell buttons on/off (default on)
const mediaCfg = c => ({ media: ["chart", "logo", "none"].includes(c.media) ? c.media : "chart", buttons: c.buttons !== false });
const tzOk = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export function cleanRule(b, ch) {
  const type = b.alertType;
  if (!TYPES.includes(type)) return { error: "INVALID_ALERT_TYPE" };
  const schedule = b.scheduleType === "daily" ? "daily" : "interval";
  const interval = int(b.intervalMin, 5, 10080, 60), tz = String(b.tz || "Asia/Kolkata");
  if (Number.isNaN(interval)) return { error: "INVALID_INTERVAL" };
  if (!tzOk(tz)) return { error: "INVALID_TIMEZONE" };
  const daily = schedule === "daily" ? String(b.dailyTime || "") : null;
  if (schedule === "daily" && hhmm(daily) === null) return { error: "INVALID_DAILY_TIME" };
  const c = b.config || {}; let config = {};
  if (type === "price") {
    const coins = [...new Set(parseList(c.coins).map(x => x.toLowerCase()))];
    if (coins.length > 25 || coins.some(x => !/^[a-z0-9-]{1,80}$/.test(x))) return { error: "INVALID_COINS" };
    if (!coins.length && ch.network === "all") return { error: "COINS_REQUIRED" };
    const mode = c.mode === "change" ? "change" : "digest", pct = num(c.minChangePct, 0.1, 100, 2);
    if (Number.isNaN(pct)) return { error: "INVALID_THRESHOLD" };
    config = { coins, mode, ...(mode === "change" ? { minChangePct: pct } : {}), ...mediaCfg(c) };
  } else if (type === "new_token") {
    const maxAgeHours = int(c.maxAgeHours, 1, 168, 24), minLiquidityUsd = num(c.minLiquidityUsd, 0, 1e9, 5000), maxPerRun = int(c.maxPerRun, 1, 10, 3);
    if ([maxAgeHours, minLiquidityUsd, maxPerRun].some(Number.isNaN)) return { error: "INVALID_THRESHOLD" };
    config = { maxAgeHours, minLiquidityUsd, maxPerRun };
  } else if (type === "liquidity") {
    const tokens = (Array.isArray(c.tokens) ? c.tokens : []).map(t => ({ chain: String(t.chain || (ch.network !== "all" ? ch.network : "")).toLowerCase(), address: String(t.address || "").trim(), label: String(t.label || "").trim().slice(0, 30) }));
    if (!tokens.length || tokens.length > 20 || tokens.some(t => !NETWORKS.includes(t.chain) || !validAddr(t.chain, t.address))) return { error: "INVALID_TOKENS" };
    const dropPct = num(c.dropPct, 5, 99, 20), risePct = num(c.risePct, 0, 10000, 0), minLiquidityUsd = num(c.minLiquidityUsd, 0, 1e10, 0);
    if ([dropPct, risePct, minLiquidityUsd].some(Number.isNaN)) return { error: "INVALID_THRESHOLD" };
    config = { tokens, dropPct, risePct, minLiquidityUsd };
  } else if (type === "whale") {
    if (ch.network !== "all" && !WHALE_NETS.includes(ch.network)) return { error: "WHALE_NETWORK_UNSUPPORTED" };
    const minUsd = num(c.minUsd, 10000, 1e9, 100000), maxPerRun = int(c.maxPerRun, 1, 10, 5);
    if ([minUsd, maxPerRun].some(Number.isNaN)) return { error: "INVALID_THRESHOLD" };
    config = { minUsd, maxPerRun };
  } else { // movers / trending
    const top = int(c.top, 3, 10, type === "movers" ? 5 : 7);
    if (Number.isNaN(top)) return { error: "INVALID_THRESHOLD" };
    config = { top, ...mediaCfg(c) };
  }
  return { value: { type, schedule, interval, daily, tz, config, enabled: b.enabled !== false } };
}

/* ---------------------------------- admin API ---------------------------------- */
export async function channelsAdmin(req, res, path, s, audit, query) {
  const need = m => { if (req.method !== m) { methodNotAllowed(res, [m]); return false; } return true; };
  const bad = (code, status = 400, extra = {}) => send(res, status, { ok: false, error: code, ...extra });
  const id = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  const body = req.body || {};
  try {
    if (path === "/api/admin/channels") {
      if (!need("GET")) return true;
      const q = sql => db().query(sql);
      const [ch, ru, lg, st] = await Promise.all([
        q(`SELECT id, name, chat_id, network, enabled, last_error, last_posted_at, created_at FROM broadcast_channels ORDER BY created_at DESC LIMIT 500`),
        q(`SELECT id, channel_id, alert_type, enabled, schedule_type, interval_min, daily_time, tz, config, last_run_at, last_posted_at, last_error FROM channel_rules ORDER BY id LIMIT 5000`),
        q(`SELECT l.id, l.channel_id, c.name AS channel_name, l.alert_type, l.status, l.summary, l.error, l.created_at FROM channel_post_log l JOIN broadcast_channels c ON c.id=l.channel_id ORDER BY l.id DESC LIMIT 30`),
        q(`SELECT COUNT(*) FILTER (WHERE status='sent')::int AS sent24, COUNT(*) FILTER (WHERE status='failed')::int AS failed24 FROM channel_post_log WHERE created_at > NOW() - INTERVAL '24 hours'`)
      ]);
      const by = {}; for (const r of ru.rows) (by[r.channel_id] ||= []).push(r);
      send(res, 200, { ok: true, networks: NETWORKS, types: TYPES, channels: ch.rows.map(c => ({ ...c, rules: by[c.id] || [] })), log: lg.rows, stats: st.rows[0] });
      return true;
    }
    if (path === "/api/admin/channel-save") {
      if (!need("POST")) return true;
      const cid = body.id ? id(body.id) : null, network = String(body.network || "all").toLowerCase();
      if ((body.id && !cid) || (network !== "all" && !NETWORKS.includes(network))) { bad("INVALID_REQUEST"); return true; }
      const chat = normalizeChat(body.chatId); if (!chat) { bad("INVALID_CHAT_ID"); return true; }
      const old = cid ? (await db().query(`SELECT chat_id FROM broadcast_channels WHERE id=$1`, [cid])).rows[0] : null;
      if (cid && !old) { bad("CHANNEL_NOT_FOUND", 404); return true; }
      const v = await verifyChannel(chat); if (v.error) { bad(v.error, 422, { detail: v.detail }); return true; }
      const name = String(body.name || "").trim().slice(0, 60) || v.title, enabled = body.enabled !== false;
      try {
        if (cid) await db().query(`UPDATE broadcast_channels SET name=$2, chat_id=$3, network=$4, enabled=$5, last_error=NULL, updated_at=NOW() WHERE id=$1`, [cid, name, v.id, network, enabled]);
        else {
          const ins = await db().query(`INSERT INTO broadcast_channels (name, chat_id, network, enabled, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, v.id, network, enabled, s.id]);
          body.id = ins.rows[0].id;
        }
      } catch (e) { if (e.code === "23505") { bad("CHANNEL_EXISTS", 409); return true; } throw e; }
      await audit(s.id, cid ? "admin.channel.update" : "admin.channel.create", "channel", cid || body.id, { network, chat: v.id });
      send(res, 200, { ok: true, id: cid || body.id });
      return true;
    }
    if (path === "/api/admin/channel-toggle") {
      if (!need("POST")) return true;
      const cid = id(body.id); if (!cid || typeof body.enabled !== "boolean") { bad("INVALID_REQUEST"); return true; }
      const r = await db().query(`UPDATE broadcast_channels SET enabled=$2, updated_at=NOW() WHERE id=$1 RETURNING id`, [cid, body.enabled]);
      if (!r.rowCount) { bad("CHANNEL_NOT_FOUND", 404); return true; }
      await audit(s.id, "admin.channel." + (body.enabled ? "on" : "off"), "channel", cid);
      send(res, 200, { ok: true }); return true;
    }
    if (path === "/api/admin/channel-delete") {
      if (!need("POST")) return true;
      const cid = id(body.id); if (!cid) { bad("INVALID_REQUEST"); return true; }
      const r = await db().query(`DELETE FROM broadcast_channels WHERE id=$1 RETURNING id`, [cid]);
      if (!r.rowCount) { bad("CHANNEL_NOT_FOUND", 404); return true; }
      await audit(s.id, "admin.channel.delete", "channel", cid);
      send(res, 200, { ok: true }); return true;
    }
    if (path === "/api/admin/channel-test" || path === "/api/admin/channel-send") {
      if (!need("POST")) return true;
      const cid = id(body.id), manual = path.endsWith("send");
      const text = manual ? String(body.text || "").trim() : "✅ Test message from Blockchain Tracker bot.\nThis channel is connected.";
      if (!cid || !text || text.length > 3500) { bad("INVALID_REQUEST"); return true; }
      const c = (await db().query(`SELECT id, chat_id FROM broadcast_channels WHERE id=$1`, [cid])).rows[0];
      if (!c) { bad("CHANNEL_NOT_FOUND", 404); return true; }
      const r = await tgSend(c.chat_id, text);
      await db().query(`INSERT INTO channel_post_log (channel_id, alert_type, status, summary, error) VALUES ($1,$2,$3,$4,$5)`, [cid, manual ? "manual" : "test", r.ok ? "sent" : "failed", text.slice(0, 500), r.ok ? null : r.error]).catch(() => {});
      await db().query(r.ok ? `UPDATE broadcast_channels SET last_error=NULL, last_posted_at=NOW() WHERE id=$1` : `UPDATE broadcast_channels SET last_error=$2 WHERE id=$1`, r.ok ? [cid] : [cid, r.error]).catch(() => {});
      if (manual) await audit(s.id, "admin.channel.send", "channel", cid);
      if (!r.ok) { bad("SEND_FAILED", 502, { detail: r.error }); return true; }
      send(res, 200, { ok: true }); return true;
    }
    if (path === "/api/admin/rule-save") {
      if (!need("POST")) return true;
      const rid = body.id ? id(body.id) : null; if (body.id && !rid) { bad("INVALID_REQUEST"); return true; }
      const old = rid ? (await db().query(`SELECT channel_id, config, schedule_type, daily_time, tz FROM channel_rules WHERE id=$1`, [rid])).rows[0] : null;
      if (rid && !old) { bad("RULE_NOT_FOUND", 404); return true; }
      const cid = old ? old.channel_id : id(body.channelId); if (!cid) { bad("INVALID_REQUEST"); return true; }
      const ch = (await db().query(`SELECT id, network FROM broadcast_channels WHERE id=$1`, [cid])).rows[0];
      if (!ch) { bad("CHANNEL_NOT_FOUND", 404); return true; }
      const c = cleanRule(body, ch); if (c.error) { bad(c.error); return true; }
      const v = c.value, cfg = JSON.stringify(v.config);
      // a daily rule created/edited after today's time must wait for tomorrow instead of firing at once
      const skipToday = v.schedule === "daily" && localParts(new Date(), v.tz).mins >= hhmm(v.daily);
      let out;
      if (rid) {
        const same = JSON.stringify(old.config) === cfg;
        const sched = old.schedule_type !== v.schedule || old.daily_time !== v.daily || old.tz !== v.tz;
        out = rid;
        await db().query(`UPDATE channel_rules SET alert_type=$2, enabled=$3, schedule_type=$4, interval_min=$5, daily_time=$6, tz=$7, config=$8::jsonb,
                            state=CASE WHEN $9 THEN state ELSE '{}'::jsonb END, last_error=NULL,
                            last_run_at=CASE WHEN $10 THEN NOW() ELSE last_run_at END, updated_at=NOW() WHERE id=$1`,
          [rid, v.type, v.enabled, v.schedule, v.interval, v.daily, v.tz, cfg, same, sched && skipToday]);
      } else {
        out = (await db().query(`INSERT INTO channel_rules (channel_id, alert_type, enabled, schedule_type, interval_min, daily_time, tz, config, last_run_at)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, CASE WHEN $9 THEN NOW() ELSE NULL END) RETURNING id`,
          [cid, v.type, v.enabled, v.schedule, v.interval, v.daily, v.tz, cfg, skipToday])).rows[0].id;
      }
      await audit(s.id, rid ? "admin.rule.update" : "admin.rule.create", "channel_rule", out, { channel: cid, type: v.type });
      send(res, 200, { ok: true, id: out }); return true;
    }
    if (path === "/api/admin/rule-toggle") {
      if (!need("POST")) return true;
      const rid = id(body.id); if (!rid || typeof body.enabled !== "boolean") { bad("INVALID_REQUEST"); return true; }
      const r = await db().query(`UPDATE channel_rules SET enabled=$2, updated_at=NOW() WHERE id=$1 RETURNING id`, [rid, body.enabled]);
      if (!r.rowCount) { bad("RULE_NOT_FOUND", 404); return true; }
      await audit(s.id, "admin.rule." + (body.enabled ? "on" : "off"), "channel_rule", rid);
      send(res, 200, { ok: true }); return true;
    }
    if (path === "/api/admin/rule-delete") {
      if (!need("POST")) return true;
      const rid = id(body.id); if (!rid) { bad("INVALID_REQUEST"); return true; }
      const r = await db().query(`DELETE FROM channel_rules WHERE id=$1 RETURNING id`, [rid]);
      if (!r.rowCount) { bad("RULE_NOT_FOUND", 404); return true; }
      await audit(s.id, "admin.rule.delete", "channel_rule", rid);
      send(res, 200, { ok: true }); return true;
    }
    if (path === "/api/admin/rule-run") { // "Send now": ignores the schedule, posts immediately
      if (!need("POST")) return true;
      const rid = id(body.id); if (!rid) { bad("INVALID_REQUEST"); return true; }
      const r = (await db().query(`SELECT r.id, r.alert_type, r.config, r.state, c.id AS cid, c.chat_id, c.network, c.name FROM channel_rules r JOIN broadcast_channels c ON c.id=r.channel_id WHERE r.id=$1`, [rid])).rows[0];
      if (!r) { bad("RULE_NOT_FOUND", 404); return true; }
      const out = await execRule(r, { id: r.cid, chat_id: r.chat_id, network: r.network, name: r.name }, true);
      send(res, 200, { ok: true, posted: !!out.posted, error: out.error || null, nothingToPost: !out.error && !out.posted });
      return true;
    }
    if (path === "/api/admin/coin-search") { // helps the admin find CoinGecko coin ids
      if (!need("GET")) return true;
      const term = String(query.get("q") || "").trim().slice(0, 40);
      if (term.length < 2) { send(res, 200, { ok: true, coins: [] }); return true; }
      try {
        const d = await getJ("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(term), 120000);
        send(res, 200, { ok: true, coins: (d.coins || []).slice(0, 8).map(x => ({ id: x.id, name: x.name, symbol: String(x.symbol).toUpperCase() })) });
      } catch { bad("PRICE_SOURCE_UNAVAILABLE", 502); }
      return true;
    }
  } catch (e) { if (e && e.code === "42P01") bad("CHANNELS_NOT_MIGRATED", 503); else bad("CHANNELS_FAILED", 500); return true; }
  return false;
}
