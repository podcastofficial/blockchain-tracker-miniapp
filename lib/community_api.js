// Community Crypto Monitor — Phase 4: Mini App API (dashboard, settings, address history, statistics, audit).
// Security model: the caller must be a Telegram administrator of that chat. Admin status is verified LIVE against Telegram on every
// request (cache in community_admins is only a fallback when Telegram itself is unreachable, and never for changes).
// Every query is scoped to the verified community id; unknown and not-yours both answer 404.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { tgCall } from "./tgapi.js";
import { NETWORKS, NET_CODES, isValidEvm } from "./address.js";
import { EVM } from "./balances.js";

const SETTINGS_FIELDS = {
  auto_detect: "bool", command_detect: "bool", detect_wallets: "bool", detect_contracts: "bool", detect_tokens: "bool",
  networks: "networks", dedupe_window_minutes: [1, 10080], max_notifications_per_hour: [1, 600]
};
const DEFAULTS = { auto_detect: true, command_detect: true, detect_wallets: true, detect_contracts: true, detect_tokens: true, networks: [], dedupe_window_minutes: 60, max_notifications_per_hour: 30 };

// Returns { ok:boolean, live:boolean }. Network failure to Telegram => cache fallback (reads only).
export async function verifyAdmin(communityId, chatId, tgUserId, { strict = false } = {}) {
  const r = await tgCall("getChatMember", { chat_id: chatId, user_id: Number(tgUserId) });
  if (r.ok) {
    const admin = r.result?.status === "creator" || r.result?.status === "administrator";
    if (admin) await db().query(`INSERT INTO community_admins (community_id, telegram_user_id, role) VALUES ($1,$2,$3) ON CONFLICT (community_id, telegram_user_id) DO UPDATE SET role=EXCLUDED.role, synced_at=NOW()`,
      [communityId, tgUserId, r.result.status === "creator" ? "creator" : "administrator"]).catch(() => {});
    else await db().query(`DELETE FROM community_admins WHERE community_id=$1 AND telegram_user_id=$2`, [communityId, tgUserId]).catch(() => {});
    return { ok: admin, live: true };
  }
  if (r.error_code === 0 && !strict) {                                      // Telegram unreachable: fall back to the cached admin list for READS
    const c = await db().query(`SELECT 1 FROM community_admins WHERE community_id=$1 AND telegram_user_id=$2`, [communityId, tgUserId]);
    return { ok: c.rowCount > 0, live: false };
  }
  if (r.error_code === 400 || r.error_code === 403)                         // not in chat / bot cannot see the user: not an admin
    await db().query(`DELETE FROM community_admins WHERE community_id=$1 AND telegram_user_id=$2`, [communityId, tgUserId]).catch(() => {});
  return { ok: false, live: false };
}

export function validateSettings(input) {
  const out = {};
  for (const [k, rule] of Object.entries(SETTINGS_FIELDS)) {
    if (!(k in (input || {}))) continue;
    const v = input[k];
    if (rule === "bool") { if (typeof v !== "boolean") return { error: k }; out[k] = v; }
    else if (rule === "networks") {
      if (!Array.isArray(v) || v.length > NET_CODES.length || v.some(n => !NETWORKS[n])) return { error: k };
      out[k] = [...new Set(v)];
    } else { if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) return { error: k }; out[k] = v; }
  }
  return Object.keys(out).length ? { value: out } : { error: "empty" };
}

const audit = (communityId, chatId, actor, action, metadata) => db().query(
  `INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action, metadata) VALUES ($1,$2,$3,$4,$5)`,
  [communityId, chatId, actor, action, JSON.stringify(metadata || {})]);

const getSettings = async id => ({ ...DEFAULTS, ...((await db().query(
  `SELECT auto_detect, command_detect, detect_wallets, detect_contracts, detect_tokens, networks, dedupe_window_minutes, max_notifications_per_hour FROM community_settings WHERE community_id=$1`, [id])).rows[0] || {}) });
const meta = c => ({ id: Number(c.id), chatId: String(c.chat_id), type: c.chat_type, title: c.title, username: c.username, status: c.status, canRead: c.can_read_messages, canPost: c.can_post, addedAt: c.added_at });

async function stats(id) {
  const [addr, n7, usage, top, health, contracts] = await Promise.all([
    db().query(`SELECT status, COUNT(*)::int AS n FROM community_addresses WHERE community_id=$1 GROUP BY status`, [id]),
    db().query(`SELECT status, COALESCE(result_kind,'') AS kind, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS n24
                  FROM community_notifications WHERE community_id=$1 AND created_at > NOW() - INTERVAL '7 days' GROUP BY status, COALESCE(result_kind,'')`, [id]),
    db().query(`SELECT hour_bucket, scanned, replies, addresses FROM community_usage WHERE community_id=$1 AND hour_bucket > NOW() - INTERVAL '24 hours' ORDER BY hour_bucket`, [id]),
    db().query(`SELECT address, network, kind, hit_count, last_seen_at FROM community_addresses WHERE community_id=$1 AND status='active' ORDER BY hit_count DESC, last_seen_at DESC LIMIT 5`, [id]),
    db().query(`SELECT COUNT(*) FILTER (WHERE status='retry')::int AS retrying, COUNT(*) FILTER (WHERE status='dead')::int AS dead FROM community_notifications WHERE community_id=$1 AND created_at > NOW() - INTERVAL '7 days'`, [id]),
    db().query(`SELECT COUNT(*) FILTER (WHERE status IN ('active','discovering'))::int AS active FROM community_contract_watches WHERE community_id=$1`,[id]).catch(()=>({rows:[{active:0}]}))
  ]);
  const addresses = { active: 0, pending_chain: 0, removed: 0 }; addr.rows.forEach(r => { addresses[r.status] = r.n; });
  const notif = { sent7d: 0, sent24h: 0, suppressed7d: 0, dead7d: 0, byKind: {} };
  for (const r of n7.rows) {
    if (r.status === "sent") { notif.sent7d += r.n; notif.sent24h += r.n24; if (r.kind) notif.byKind[r.kind] = (notif.byKind[r.kind] || 0) + r.n; }
    else if (r.status === "suppressed") notif.suppressed7d += r.n; else if (r.status === "dead") notif.dead7d += r.n;
  }
  return { addresses, contractWatches: contracts.rows[0]?.active || 0, notifications: notif, queue: health.rows[0], hourly: usage.rows.map(r => ({ hour: r.hour_bucket, scanned: r.scanned, replies: r.replies, addresses: r.addresses })),
    scanned24h: usage.rows.reduce((a, r) => a + r.scanned, 0), top: top.rows };
}

async function handle(req, res, path) {
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  const tgId = String(session.telegram_user_id || "");
  if (!/^\d{1,15}$/.test(tgId)) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  const mt = /^\/api\/community(?:\/(\d{1,15})(?:\/([a-z-]+))?)?\/?$/.exec(path);
  if (!mt) return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  const [, idStr, sub] = mt, write = req.method === "POST";
  if (req.method !== "GET" && !write) return methodNotAllowed(res, ["GET", "POST"]);
  if (rateLimited(req, res, write ? "community-w" : "community-r", session.id, write ? 20 : 120)) return;

  if (!idStr) {                                                             // GET /api/community
    if (write) return methodNotAllowed(res, ["GET"]);
    const r = await db().query(
      `SELECT c.id, c.chat_id, c.chat_type, c.title, c.username, c.status, c.can_read_messages, c.can_post, c.added_at,
              (SELECT COUNT(*)::int FROM community_addresses a WHERE a.community_id=c.id AND a.status='active') AS addresses,
              (SELECT COUNT(*)::int FROM community_notifications n WHERE n.community_id=c.id AND n.status='sent' AND n.created_at > NOW() - INTERVAL '24 hours') AS sent24h
         FROM communities c JOIN community_admins a ON a.community_id=c.id
        WHERE a.telegram_user_id=$1 AND c.status<>'disconnected' ORDER BY c.title NULLS LAST, c.id LIMIT 100`, [tgId]);
    return send(res, 200, { ok: true, bot: String(process.env.BOT_USERNAME || "").replace(/^@/, "") || null,
      networks: Object.fromEntries(NET_CODES.map(n => [n, NETWORKS[n].name])),
      communities: r.rows.map(c => ({ ...meta(c), addresses: c.addresses, sent24h: c.sent24h })) });
  }

  const cr = await db().query(`SELECT id, chat_id, chat_type, title, username, status, can_read_messages, can_post, added_at FROM communities WHERE id=$1`, [idStr]);
  const c = cr.rows[0];
  if (!c) return send(res, 404, { ok: false, error: "COMMUNITY_NOT_FOUND" });
  const adm = await verifyAdmin(c.id, c.chat_id, tgId, { strict: write });
  if (!adm.ok) return send(res, 404, { ok: false, error: "COMMUNITY_NOT_FOUND" });
  const id = Number(c.id), q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);

  if (!write && sub === "settings") return send(res, 200, { ok: true, community: meta(c), settings: await getSettings(id) });

  if (write && sub === "settings") {
    const v = validateSettings(req.body);
    if (v.error) return send(res, 400, { ok: false, error: "INVALID_SETTINGS", field: v.error });
    if (c.status === "disconnected") return send(res, 409, { ok: false, error: "COMMUNITY_DISCONNECTED" });
    const before = await getSettings(id), changes = {};
    for (const [k, val] of Object.entries(v.value)) if (JSON.stringify(before[k]) !== JSON.stringify(val)) changes[k] = { from: before[k], to: val };
    if (Object.keys(changes).length) {
      const cols = Object.keys(v.value), params = [id, ...cols.map(k => v.value[k])];
      await db().query(
        `INSERT INTO community_settings (community_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => "$" + (i + 2)).join(", ")})
         ON CONFLICT (community_id) DO UPDATE SET ${cols.map(k => `${k}=EXCLUDED.${k}`).join(", ")}, updated_at=NOW()`, params);
      await audit(id, c.chat_id, tgId, "settings.updated", { changes });
    }
    return send(res, 200, { ok: true, settings: await getSettings(id), changed: Object.keys(changes) });
  }

  if (!write && sub === "stats") return send(res, 200, { ok: true, community: meta(c), stats: await stats(id) });

  if (!write && sub === "addresses") {
    const status = ["active", "pending_chain", "removed"].includes(q.status) ? q.status : null;
    const net = NETWORKS[q.network] ? q.network : null;
    const term = String(q.q || "").trim().slice(0, 64).replace(/[%_\\]/g, m => "\\" + m);
    const offset = Math.max(0, Math.min(Number(q.offset) || 0, 10000)), limit = 25;
    const r = await db().query(
      `SELECT id, address, network, kind, status, source, hit_count, first_seen_at, last_seen_at FROM community_addresses
        WHERE community_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR network=$3) AND ($4='' OR address ILIKE '%' || $4 || '%')
        ORDER BY last_seen_at DESC, id DESC LIMIT $5 OFFSET $6`, [id, status, net, term, limit + 1, offset]);
    return send(res, 200, { ok: true, addresses: r.rows.slice(0, limit), nextOffset: r.rows.length > limit ? offset + limit : null });
  }

  // Per-community contract watchlist (EVM DEX swap monitoring).
  if (!write && sub === "contract-watches") {
    const r = await db().query(`SELECT id, network, token_address, token_name, token_symbol, pair_address, status, last_error, created_at FROM community_contract_watches WHERE community_id=$1 AND status<>'removed' ORDER BY created_at DESC LIMIT 100`, [id]);
    return send(res, 200, { ok: true, networks: Object.keys(EVM), watches: r.rows });
  }

  if (write && sub === "contract-watches") {
    if (c.status !== "active") return send(res, 409, { ok:false, error:"COMMUNITY_NOT_ACTIVE" });
    const network=String(req.body?.network||"").toLowerCase(), address=String(req.body?.address||"").trim();
    if (!EVM[network] || !isValidEvm(address)) return send(res,400,{ok:false,error:"INVALID_CONTRACT_OR_NETWORK"});
    const norm=address.toLowerCase();
    const r=await db().query(`INSERT INTO community_contract_watches(community_id,network,token_address,token_norm,created_by,status) VALUES($1,$2,$3,$4,$5,'discovering') ON CONFLICT(community_id,network,token_norm) DO UPDATE SET status=CASE WHEN community_contract_watches.status IN ('removed','error') THEN 'discovering' ELSE community_contract_watches.status END,updated_at=NOW() RETURNING id,status`,[id,network,address,norm,tgId]);
    await audit(id,c.chat_id,tgId,"community.contract_watch_added",{network,address:norm});
    return send(res,200,{ok:true,watch:r.rows[0]});
  }

  if (write && sub === "contract-remove") {
    const wid=Number(req.body?.watchId);
    if(!Number.isSafeInteger(wid)||wid<=0)return send(res,400,{ok:false,error:"INVALID_REQUEST"});
    const r=await db().query(`UPDATE community_contract_watches SET status='removed',updated_at=NOW() WHERE id=$1 AND community_id=$2 AND status<>'removed' RETURNING token_address,network`,[wid,id]);
    if(!r.rowCount)return send(res,404,{ok:false,error:"CONTRACT_WATCH_NOT_FOUND"});
    await audit(id,c.chat_id,tgId,"community.contract_watch_removed",r.rows[0]);
    return send(res,200,{ok:true});
  }

  if (!write && sub === "audit") {
    const r = await db().query(`SELECT action, actor_telegram_id::text AS actor, metadata, created_at FROM community_audit_logs WHERE community_id=$1 ORDER BY id DESC LIMIT 50`, [id]);
    return send(res, 200, { ok: true, audit: r.rows });
  }

  if (write && sub === "control") {
    const action = req.body?.action;
    if (c.status === "disconnected") return send(res, 409, { ok: false, error: "COMMUNITY_DISCONNECTED" });
    if (action === "pause" || action === "resume") {
      const to = action === "pause" ? "paused" : "active", from = action === "pause" ? "active" : "paused";
      const r = await db().query(`UPDATE communities SET status=$2, updated_at=NOW() WHERE id=$1 AND status=$3`, [id, to, from]);
      if (r.rowCount) await audit(id, c.chat_id, tgId, "community." + (action === "pause" ? "paused" : "resumed"), { via: "miniapp" });
      return send(res, 200, { ok: true, status: to });
    }
    if (action === "disconnect") {
      await db().query(`UPDATE communities SET status='disconnected', can_read_messages=FALSE, can_post=FALSE, disconnected_at=NOW(), updated_at=NOW() WHERE id=$1`, [id]);
      await audit(id, c.chat_id, tgId, "community.disconnected", { via: "miniapp" });
      await tgCall("leaveChat", { chat_id: c.chat_id });                    // stops all future processing; settings/history stay for a later re-add
      return send(res, 200, { ok: true, status: "disconnected" });
    }
    return send(res, 400, { ok: false, error: "INVALID_ACTION" });
  }

  if (write && sub === "address-remove") {
    const aid = Number(req.body?.addressId);
    if (!Number.isSafeInteger(aid) || aid <= 0) return send(res, 400, { ok: false, error: "INVALID_REQUEST" });
    const r = await db().query(`UPDATE community_addresses SET status='removed' WHERE id=$1 AND community_id=$2 AND status<>'removed' RETURNING address_norm`, [aid, id]);
    if (!r.rowCount) return send(res, 404, { ok: false, error: "ADDRESS_NOT_FOUND" });
    await audit(id, c.chat_id, tgId, "community.address_removed", { address: r.rows[0].address_norm, via: "miniapp" });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
}

// Missing tables (migrations not run yet) get a clear, actionable answer instead of a generic 500.
export async function communityApi(req, res, path) {
  try { return await handle(req, res, path); }
  catch (e) {
    if (e && e.code === "42P01") {
      console.error("COMMUNITY_NOT_SET_UP", e.message);
      return send(res, 503, { ok: false, error: "COMMUNITY_NOT_SET_UP" });
    }
    throw e;
  }
}
