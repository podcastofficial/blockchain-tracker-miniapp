// Compulsory join (channel + group) before the bot / Mini App can be used.
// - Bot /start shows the join buttons (lib/bot.js uses forceJoinStatus + joinPromptExtra)
// - Mini App + API: JOIN_REQUIRED gate (joinBlocked is called from api/index.js)
// - Admin: add / remove / ON-OFF every required chat + master switch (forceJoinAdmin is called from lib/admin.js)
// Tables are created automatically on first use (CREATE TABLE IF NOT EXISTS), so no manual SQL is needed.
// Fails OPEN: if the DB table or Telegram check is unavailable nobody is locked out of the app.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { tgCall } from "./tgapi.js";
import { normalizeChat } from "./channels.js";

const DEFAULTS = [
  { title: "Multi Chain Tracker Channel", kind: "channel", chat_ref: "@MultiChainTrackerChannel", sort: 1 },
  { title: "Multi Chain Community", kind: "group", chat_ref: "@MultiChainCommunity", sort: 2 }
];
const MAX_ITEMS = 10;
const JOINED_TTL = 120000;          // a "joined" result is trusted for 2 minutes; "not joined" is never cached
const CFG_TTL = 20000;

/* ------------------------------- schema + config ------------------------------- */
let schemaP = null;
function ensureSchema() {
  if (!schemaP) schemaP = (async () => {
    const q = (s, p) => db().query(s, p);
    await q(`CREATE TABLE IF NOT EXISTS force_join_settings (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), enabled BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS force_join_items (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','group')),
      chat_ref TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const first = await q(`INSERT INTO force_join_settings (id, enabled) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING RETURNING id`);
    if (first.rowCount) {            // very first run only: add the two default chats (never re-added after an admin deletes them)
      for (const d of DEFAULTS) {
        await q(`INSERT INTO force_join_items (title, kind, chat_ref, url, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_ref) DO NOTHING`,
          [d.title, d.kind, d.chat_ref, "https://t.me/" + d.chat_ref.slice(1), d.sort]);
      }
    }
  })().catch(e => { schemaP = null; throw e; });
  return schemaP;
}

let cfgCache = null;
export function clearJoinCache() { cfgCache = null; memberCache.clear(); }
async function loadConfig() {
  if (cfgCache && Date.now() - cfgCache.t < CFG_TTL) return cfgCache.v;
  await ensureSchema();
  const [s, i] = await Promise.all([
    db().query(`SELECT enabled FROM force_join_settings WHERE id=1`),
    db().query(`SELECT id, title, kind, chat_ref, url, enabled, sort_order FROM force_join_items ORDER BY sort_order, id`)
  ]);
  const v = { enabled: s.rows[0]?.enabled !== false, items: i.rows };
  cfgCache = { t: Date.now(), v };
  return v;
}

const adminIds = () => String(process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
export const isAdminTg = tgId => adminIds().includes(String(tgId));

/* ------------------------------ membership check ------------------------------ */
const memberCache = new Map();    // "chat_ref|tgId" -> timestamp of last positive check
function isMemberStatus(m) {
  if (!m) return false;
  if (["creator", "administrator", "member"].includes(m.status)) return true;
  return m.status === "restricted" && m.is_member === true;
}
// true = joined, false = not joined, null = could not be checked (bot not admin / chat missing / network)
async function checkOne(item, tgId, fresh) {
  const key = item.chat_ref + "|" + tgId;
  const hit = memberCache.get(key);
  if (!fresh && hit && Date.now() - hit < JOINED_TTL) return true;
  const r = await tgCall("getChatMember", { chat_id: item.chat_ref, user_id: Number(tgId) });
  if (r?.ok) {
    const ok = isMemberStatus(r.result);
    if (ok) { memberCache.set(key, Date.now()); if (memberCache.size > 5000) for (const [k, t] of memberCache) if (Date.now() - t > JOINED_TTL) memberCache.delete(k); }
    else memberCache.delete(key);
    return ok;
  }
  if (r?.error_code === 400 && /user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return false;
  return null;
}

// Returns { enabled, gateActive, allJoined, items:[{id,title,kind,url,joined}] }
// gateActive = master switch ON, at least one enabled chat, and the user is not an admin.
export async function forceJoinStatus(tgId, { fresh = false } = {}) {
  const cfg = await loadConfig();
  const active = cfg.items.filter(i => i.enabled);
  const rows = await Promise.all(active.map(async i => {
    const c = await checkOne(i, tgId, fresh);
    return { id: Number(i.id), title: i.title, kind: i.kind, url: i.url, joined: c !== false, unchecked: c === null };
  }));
  const admin = isAdminTg(tgId);
  const gateActive = cfg.enabled && rows.length > 0 && !admin;
  return { enabled: cfg.enabled, gateActive, allJoined: rows.every(r => r.joined), items: rows.map(({ unchecked, ...r }) => r) };
}

/* ------------------------------------ bot ------------------------------------ */
// Telegram message extra for the "please join" screen: URL buttons + "I've joined" check button.
export function joinPromptExtra(items) {
  const rows = items.filter(i => !i.joined).map(i => [{ text: (i.kind === "channel" ? "📢 Join Channel – " : "💬 Join Group – ") + i.title, url: i.url }]);
  rows.push([{ text: "✅ I've Joined", callback_data: "fj_check" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
export const JOIN_PROMPT_TEXT = "🔒 Join required\n\nTo use Blockchain Tracker you must join our official channel and community group first.\n\n1) Tap the buttons below and join\n2) Come back and tap “✅ I've Joined”";
export function missingNames(items) { return items.filter(i => !i.joined).map(i => i.title).join(", "); }

/* ------------------------------- API gate (Mini App) ------------------------------- */
const EXEMPT = ["/api/auth/", "/api/forcejoin", "/api/admin/", "/api/cron/", "/api/telegram/webhook", "/api/swap-config", "/api/subscription/plans", "/api/phantom/"];
// Returns true when it already answered the request with JOIN_REQUIRED.
export async function joinBlocked(req, res, path) {
  try {
    if (!path.startsWith("/api/") || EXEMPT.some(p => path.startsWith(p))) return false;
    const s = readSession(req);
    if (!s) return false;                         // the route itself answers 401
    const st = await forceJoinStatus(s.telegram_user_id);
    if (st.gateActive && !st.allJoined) { send(res, 403, { ok: false, error: "JOIN_REQUIRED", items: st.items }); return true; }
  } catch { /* fail open */ }
  return false;
}

// GET /api/forcejoin/status[?fresh=1]  -> what the Mini App needs to draw the gate screen and the in-app "Join" card
export async function forceJoinApi(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  if (rateLimited(req, res, "fjstatus", s.id, 40)) return;
  try {
    const fresh = new URL(req.url, "https://x.invalid").searchParams.get("fresh") === "1";
    const st = await forceJoinStatus(s.telegram_user_id, { fresh });
    return send(res, 200, { ok: true, enabled: st.enabled, gateActive: st.gateActive, allJoined: st.allJoined, items: st.items });
  } catch { return send(res, 200, { ok: true, enabled: false, gateActive: false, allJoined: true, items: [] }); }  // fail open
}

/* ------------------------------------ admin ------------------------------------ */
async function botState(chatRef) {
  const info = await tgCall("getChat", { chat_id: chatRef });
  if (!info?.ok) return { state: "chat_not_found", detail: String(info?.description || "").slice(0, 120) };
  const me = await tgCall("getMe", {});
  if (!me?.ok) return { state: "error", chat: info.result };
  const m = await tgCall("getChatMember", { chat_id: info.result.id, user_id: me.result.id });
  if (!m?.ok) return { state: "bot_not_in_chat", chat: info.result };
  if (!["administrator", "creator"].includes(m.result.status)) return { state: "bot_not_admin", chat: info.result };
  return { state: "ok", chat: info.result };
}
const INVITE_RE = /t\.me\/(\+|joinchat\/)/i;

export async function forceJoinAdmin(req, res, path, s, audit) {
  if (!path.startsWith("/api/admin/fj")) return false;
  const body = req.body || {};
  const need = m => { if (req.method !== m) { methodNotAllowed(res, [m]); return false; } return true; };
  const bad = (code, status = 400, extra = {}) => { send(res, status, { ok: false, error: code, ...extra }); return true; };
  await ensureSchema();

  if (path === "/api/admin/fj") {
    if (!need("GET")) return true;
    const [st, items] = await Promise.all([
      db().query(`SELECT enabled FROM force_join_settings WHERE id=1`),
      db().query(`SELECT id, title, kind, chat_ref, url, enabled, sort_order FROM force_join_items ORDER BY sort_order, id`)
    ]);
    const withBot = await Promise.all(items.rows.map(async r => ({ ...r, id: Number(r.id), bot: (await botState(r.chat_ref)).state })));
    send(res, 200, { ok: true, enabled: st.rows[0]?.enabled !== false, items: withBot });
    return true;
  }
  if (path === "/api/admin/fj-master") {
    if (!need("POST")) return true;
    const on = body.enabled === true || body.enabled === 1;
    await db().query(`UPDATE force_join_settings SET enabled=$1, updated_at=NOW() WHERE id=1`, [on]);
    clearJoinCache(); await audit(s.id, "admin.forcejoin_master", "force_join", 1, { enabled: on });
    send(res, 200, { ok: true, enabled: on }); return true;
  }
  if (path === "/api/admin/fj-toggle") {
    if (!need("POST")) return true;
    const id = Number(body.id), on = body.enabled === true || body.enabled === 1;
    if (!Number.isSafeInteger(id)) return bad("INVALID_REQUEST");
    const r = await db().query(`UPDATE force_join_items SET enabled=$2, updated_at=NOW() WHERE id=$1 RETURNING id`, [id, on]);
    if (!r.rowCount) return bad("NOT_FOUND", 404);
    clearJoinCache(); await audit(s.id, "admin.forcejoin_toggle", "force_join_item", id, { enabled: on });
    send(res, 200, { ok: true }); return true;
  }
  if (path === "/api/admin/fj-delete") {
    if (!need("POST")) return true;
    const id = Number(body.id);
    if (!Number.isSafeInteger(id)) return bad("INVALID_REQUEST");
    const r = await db().query(`DELETE FROM force_join_items WHERE id=$1 RETURNING id, chat_ref`, [id]);
    if (!r.rowCount) return bad("NOT_FOUND", 404);
    clearJoinCache(); await audit(s.id, "admin.forcejoin_delete", "force_join_item", id, { chat: r.rows[0].chat_ref });
    send(res, 200, { ok: true }); return true;
  }
  if (path === "/api/admin/fj-save") {              // add (no id) or edit (id)
    if (!need("POST")) return true;
    const id = body.id == null || body.id === "" ? null : Number(body.id);
    if (id !== null && !Number.isSafeInteger(id)) return bad("INVALID_REQUEST");
    const link = String(body.link || "").trim().slice(0, 200);
    let title = String(body.title || "").trim().slice(0, 60);
    const on = body.enabled === undefined ? true : (body.enabled === true || body.enabled === 1);
    const sort = Number.isInteger(Number(body.sort)) ? Math.min(Math.max(Number(body.sort), 1), 999) : 100;
    let chatRef, url;
    if (INVITE_RE.test(link)) {                      // private chat: invite link for the button + numeric chat id for the check
      chatRef = String(body.chatId || "").trim();
      if (!/^-100\d{5,15}$/.test(chatRef)) return bad("CHAT_ID_REQUIRED_FOR_INVITE_LINK");
      url = link.startsWith("http") ? link : "https://" + link.replace(/^\/+/, "");
    } else {
      chatRef = normalizeChat(link);
      if (!chatRef) return bad("INVALID_LINK");
      url = chatRef.startsWith("@") ? "https://t.me/" + chatRef.slice(1) : null;
      if (!url) return bad("USE_USERNAME_OR_INVITE_LINK");
    }
    const bs = await botState(chatRef);
    if (bs.state === "chat_not_found") return bad("CHAT_NOT_FOUND", 400, { detail: bs.detail });
    const kind = bs.chat?.type === "channel" ? "channel" : "group";
    if (!title) title = String(bs.chat?.title || chatRef).slice(0, 60);
    try {
      if (id === null) {
        const n = await db().query(`SELECT COUNT(*)::int AS n FROM force_join_items`);
        if (n.rows[0].n >= MAX_ITEMS) return bad("LIMIT_REACHED");
        const r = await db().query(`INSERT INTO force_join_items (title, kind, chat_ref, url, enabled, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [title, kind, chatRef, url, on, sort]);
        await audit(s.id, "admin.forcejoin_add", "force_join_item", r.rows[0].id, { chat: chatRef });
      } else {
        const r = await db().query(`UPDATE force_join_items SET title=$2, kind=$3, chat_ref=$4, url=$5, enabled=$6, sort_order=$7, updated_at=NOW() WHERE id=$1 RETURNING id`, [id, title, kind, chatRef, url, on, sort]);
        if (!r.rowCount) return bad("NOT_FOUND", 404);
        await audit(s.id, "admin.forcejoin_edit", "force_join_item", id, { chat: chatRef });
      }
    } catch (e) {
      if (e && e.code === "23505") return bad("ALREADY_ADDED", 409);
      throw e;
    }
    clearJoinCache();
    send(res, 200, { ok: true, bot: bs.state }); return true;
  }
  return false;
}
