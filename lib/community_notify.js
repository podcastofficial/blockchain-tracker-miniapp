// Community Crypto Monitor — Phase 3: notification templates + durable queue.
// Flow: enqueue (deduplicated, rate-limited, persisted) -> send inline right away -> the 5-minute worker retries anything left over.
// Notifications are always delivered to the community row they were queued for (never to a chat id taken from elsewhere).
import { db } from "./db.js";
import { tgCall } from "./tgapi.js";
import { deepLink } from "./rich.js";
import { NETWORKS, explorerAddrLink, explorerTxLink } from "./address.js";
import { enrichAddress, enrichTx } from "./community_enrich.js";
import { H, NET_EMOJI, renderKey, loadTemplates } from "./templates.js";

export const MAX_ATTEMPTS = 5;
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const short = a => a && a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || "?");
export const fmtUsd = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "unavailable"
  : n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : n >= 1 ? "$" + Number(n).toFixed(2) : n === 0 ? "$0" : "$" + Number(n).toPrecision(3);
export const fmtAmt = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "unavailable"
  : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? Number(n.toFixed(4)).toString() : n === 0 ? "0" : Number(n.toPrecision(4)).toString();
const utc = t => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const NOT_VERDICT = "This is information only — not a safety verdict, audit or investment advice.";
const link = (url, text) => url ? H(`<a href="${String(url).replace(/"/g, "&quot;")}">${esc(text)}</a>`) : null;

// Facts derived from DEX data. Labelled as notes, never as "safe" / "unsafe".
export function riskNotes(token) {
  if (!token) return [];
  const n = [];
  if (token.liquidity !== null && token.liquidity < 10000) n.push("Low liquidity (under $10k)");
  if (token.created) { const age = Date.now() - token.created; if (age < 86400000) n.push("Trading pair is less than 24h old"); else if (age < 7 * 86400000) n.push("Trading pair is less than 7 days old"); }
  if (!(token.websites?.length || token.socials?.length)) n.push("No website or social profile listed on DEX Screener");
  return n;
}

// rows: array of button rows. URL buttons must be https; callback buttons carry callback_data. Empty rows are dropped.
function buttons(rows) {
  const keep = rows.map(r => r.filter(b => b && b.text && ((b.url && /^https:\/\//.test(b.url)) || b.callback_data))).filter(r => r.length);
  return keep.length ? { reply_markup: { inline_keyboard: keep } } : {};
}

export function formatAddressNotification(d, { notifId = null, templates = null } = {}) {
  const net = NETWORKS[d.network].name, t = d.token;
  const kind = ["wallet", "contract", "token"].includes(d.kind) ? d.kind : "wallet";
  const risks = riskNotes(t);
  const change = t && t.change?.h24 != null ? `(24h ${t.change.h24 >= 0 ? "🟢 +" : "🔴 "}${Number(t.change.h24).toFixed(1)}%)` : "";
  const vars = {
    network: net, net_emoji: NET_EMOJI[d.network] || "🌐", address: d.address,
    name: d.name || d.symbol || "Unnamed token", symbol: d.name && d.symbol ? d.symbol : "",
    balance: d.native ? `${fmtAmt(d.native.amount)} ${d.native.symbol}${d.native.usd !== null && d.native.usd !== undefined ? " (~" + fmtUsd(d.native.usd) + ")" : ""}` : "unavailable",
    stables: H((d.stables || []).map(x => `💵 <b>${esc(x.symbol)}:</b> ${fmtAmt(x.amount)}`).join("\n")),
    price: t ? (t.priceUsd !== null ? fmtUsd(t.priceUsd) : "unavailable") : "", change24h: change,
    liquidity: t ? fmtUsd(t.liquidity) : "", volume24h: t ? fmtUsd(t.volume?.h24 ?? t.volume) : "", market_cap: t ? fmtUsd(t.marketCap ?? t.fdv) : "",
    supply: d.supply ? fmtAmt(d.supply) : "", market_missing: d.kind === "token" && !t ? "Price, liquidity and volume: unavailable" : "",
    notes: H((d.notes || []).map(x => "ℹ️ " + esc(x)).join("\n")),
    unavailable: d.unavailable?.length ? "⚠️ Unavailable right now: " + d.unavailable.join(", ") : "",
    risks: H(risks.length ? "⚠️ <b>Notes</b>\n" + risks.map(r => "• " + esc(r)).join("\n") : ""),
    disclaimer: NOT_VERDICT, source: d.source?.length ? d.source.join(" · ") : "", updated: utc(d.updatedAt)
  };
  const canSave = notifId && ["wallet", "contract", "token"].includes(d.kind);
  return { text: renderKey("address_" + kind, vars, templates), ...buttons([
    [{ text: "🔎 View on Explorer", url: explorerAddrLink(d.network, d.address) }, d.token && { text: "📈 Token Details", url: d.token.url }],
    [canSave && { text: "💾 Save to My Tracker", callback_data: "sv:" + notifId }, { text: "📊 Open Tracker", url: deepLink("a_" + d.network) }]]) };
}

export function formatTxNotification(d, { templates = null } = {}) {
  if (d.status === "not_found" || d.status === "unavailable" || !d.network) {
    const reason = d.status === "unavailable" ? "I couldn't reach the network data source. Try again shortly." : "This transaction wasn't found on the enabled networks (it may be too new, pending in the mempool, or on another network).";
    return { text: renderKey("tx_notfound", { hash: d.hash, reason }, templates) };
  }
  const net = NETWORKS[d.network];
  const st = { success: ["✅", "Success"], failed: ["❌", "Failed"], pending: ["⏳", "Pending"] }[d.status] || ["ℹ️", d.status];
  const addrLink = a => a ? link(explorerAddrLink(d.network, a), short(a)) : null;
  const vars = {
    network: net.name, net_emoji: NET_EMOJI[d.network] || "🌐", status: st[1], status_icon: st[0], hash: d.hash, block: d.block, time: d.time ? utc(d.time) : "",
    method: d.txType || "", from: d.from ? short(d.from) : "", from_link: addrLink(d.from), from_full: d.from, to: d.to ? short(d.to) : "", to_link: addrLink(d.to), to_full: d.to,
    amount: d.value && d.value.amount > 0 ? `${fmtAmt(d.value.amount)} ${d.value.symbol}${d.value.usd ? " (~" + fmtUsd(d.value.usd) + ")" : ""}` : "",
    fee: d.fee ? `${fmtAmt(d.fee.amount)} ${d.fee.symbol}` : "", updated: utc(d.updatedAt), explorer_link: explorerTxLink(d.network, d.hash)
  };
  return { text: renderKey("tx", vars, templates), ...buttons([[{ text: "🔎 View on Explorer", url: explorerTxLink(d.network, d.hash) }, { text: "📊 Open Tracker", url: deepLink("a_" + d.network) }]]) };
}

// ---------------- Queue ----------------
// Atomic hourly reply counter (also feeds the usage statistics). Returns true while the community is under its hourly limit.
export async function takeReplySlot(community) {
  const r = await db().query(
    `INSERT INTO community_usage (community_id, hour_bucket, replies) VALUES ($1, date_trunc('hour', NOW()), 1)
     ON CONFLICT (community_id, hour_bucket) DO UPDATE SET replies = community_usage.replies + 1 RETURNING replies`, [community.id]);
  return r.rows[0].replies <= community.max_notifications_per_hour;
}

// Returns the new notification id, or null when it is a duplicate or over the hourly limit.
export async function enqueueNotification(community, subject, { mode = "auto", replyTo = null, key }) {
  const ins = await db().query(
    `INSERT INTO community_notifications (community_id, dedupe_key, subject, mode, reply_to_message_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (community_id, dedupe_key) DO NOTHING RETURNING id`, [community.id, key, JSON.stringify(subject), mode, replyTo]);
  if (!ins.rowCount) return null;
  const id = ins.rows[0].id;
  if (!(await takeReplySlot(community))) {
    await db().query(`UPDATE community_notifications SET status='suppressed', last_error='rate_limited' WHERE id=$1`, [id]);
    return null;
  }
  return id;
}

const backoffSeconds = attempts => Math.min(30 * 2 ** (attempts - 1), 600) + Math.floor(Math.random() * 10);
const finish = (id, status, extra = {}) => db().query(
  `UPDATE community_notifications SET status=$2, last_error=$3, result_kind=COALESCE($4,result_kind), telegram_message_id=COALESCE($5,telegram_message_id),
     sent_at=CASE WHEN $2='sent' THEN NOW() ELSE sent_at END, locked_at=NULL WHERE id=$1`,
  [id, status, extra.error ?? null, extra.kind ?? null, extra.messageId ?? null]);
const retryLater = (id, seconds, error) => db().query(
  `UPDATE community_notifications SET status='retry', next_attempt_at=NOW() + ($2 || ' seconds')::interval, last_error=$3, locked_at=NULL WHERE id=$1`, [id, String(seconds), String(error).slice(0, 200)]);

// Atomically claims one due notification (optionally a specific id). SKIP LOCKED keeps concurrent workers from double-sending;
// rows stuck in 'sending' for over 2 minutes (crashed function) become claimable again.
async function claim(id = null) {
  const r = await db().query(
    `UPDATE community_notifications n SET status='sending', attempts=n.attempts+1, locked_at=NOW()
     WHERE n.id = (SELECT id FROM community_notifications
                    WHERE ($1::bigint IS NULL OR id=$1)
                      AND ((status IN ('pending','retry') AND next_attempt_at <= NOW()) OR (status='sending' AND locked_at < NOW() - INTERVAL '2 minutes'))
                    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING n.*`, [id]);
  return r.rows[0] || null;
}

const PERMANENT = /chat not found|bot was kicked|bot is not a member|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|bot was blocked|channel_private/i;

export async function processNotification(id = null) {
  const n = await claim(id); if (!n) return null;
  try {
    const c = (await db().query(
      `SELECT c.id, c.chat_id, c.chat_type, c.status, c.can_post, s.networks, s.detect_wallets, s.detect_contracts, s.detect_tokens
         FROM communities c LEFT JOIN community_settings s ON s.community_id=c.id WHERE c.id=$1`, [n.community_id])).rows[0];
    if (!c || c.status !== "active") return void await finish(n.id, "suppressed", { error: c ? "community_" + c.status : "community_missing" });
    if (!c.can_post) return void await finish(n.id, "dead", { error: "bot_cannot_post" });
    const sub = n.subject; let mk, kind;
    const custom = await loadTemplates();                                  // admin-edited texts (falls back to built-in defaults)
    if (sub.type === "tx") { const d = await enrichTx(sub.family, sub.hash, c.networks || []); kind = "tx"; mk = t => formatTxNotification(d, { templates: t }); }
    else {
      const d = await enrichAddress(sub.network, sub.address); kind = d.kind;
      if (n.mode === "auto" && ((kind === "wallet" && c.detect_wallets === false) || (kind === "contract" && c.detect_contracts === false) || (kind === "token" && c.detect_tokens === false)))
        return void await finish(n.id, "suppressed", { error: "type_disabled", kind });
      mk = t => formatAddressNotification(d, { notifId: n.id, templates: t });
      const label = d.name || d.symbol;
      if (label) await db().query(`UPDATE community_notifications SET display_name=$2 WHERE id=$1`, [n.id, String(label).slice(0, 50)]).catch(() => {});   // best effort (needs db/community_phase3b.sql)
      if (sub.addressId) await db().query(`UPDATE community_addresses SET kind=$2 WHERE id=$1 AND $2 IN ('wallet','contract','token')`, [sub.addressId, kind]).catch(() => {});
    }
    const post = msg => tgCall("sendMessage", { chat_id: c.chat_id, text: msg.text, parse_mode: "HTML", disable_web_page_preview: true, ...(msg.reply_markup ? { reply_markup: msg.reply_markup } : {}),
      ...(n.reply_to_message_id ? { reply_to_message_id: Number(n.reply_to_message_id), allow_sending_without_reply: true } : {}) });
    let res = await post(mk(custom));
    // An admin template with broken HTML must never silence the bot: retry once with the built-in layout.
    if (!res.ok && res.error_code === 400 && /parse entities|can't parse/i.test(String(res.description)) && Object.keys(custom).length) res = await post(mk(null));
    if (res.ok) return void await finish(n.id, "sent", { kind, messageId: res.result?.message_id });
    const desc = String(res.description || "error");
    if (res.error_code === 429) return void await retryLater(n.id, (res.parameters?.retry_after || 5) + 1, "rate_limited_by_telegram");
    if ((res.error_code === 400 || res.error_code === 403) && PERMANENT.test(desc)) {
      await db().query(`UPDATE communities SET can_post=FALSE, updated_at=NOW() WHERE id=$1`, [c.id]).catch(() => {});
      await db().query(`INSERT INTO community_audit_logs (community_id, chat_id, action, metadata) VALUES ($1,$2,'community.post_failed',$3)`, [c.id, c.chat_id, JSON.stringify({ error: desc.slice(0, 120) })]).catch(() => {});
      return void await finish(n.id, "dead", { error: desc.slice(0, 200) });
    }
    if (n.attempts >= MAX_ATTEMPTS) return void await finish(n.id, "dead", { error: desc.slice(0, 200) });   // dead-letter: kept for inspection
    return void await retryLater(n.id, backoffSeconds(n.attempts), desc);
  } catch (e) {
    if (n.attempts >= MAX_ATTEMPTS) return void await finish(n.id, "dead", { error: String(e?.message || "FAILED").slice(0, 200) });
    return void await retryLater(n.id, backoffSeconds(n.attempts), String(e?.message || "FAILED"));
  }
}

// Sends the given just-queued notifications within a time budget; leftovers stay queued for the worker.
export async function processNow(ids, budgetMs = 7000) {
  const t0 = Date.now();
  for (const id of ids) { if (Date.now() - t0 > budgetMs) break; await processNotification(id).catch(() => {}); }
}
// Worker (called by the 5-minute maintenance run): retries, stuck rows, anything the inline send did not finish.
export async function processQueue(budgetMs = 10000) {
  const t0 = Date.now(); let done = 0;
  while (Date.now() - t0 < budgetMs && done < 40) {
    const r = await processNotification(null).catch(() => undefined);   // null = nothing due; undefined = handled (even if it errored)
    if (r === null) break;
    done++;
  }
  return { processed: done };
}
export async function purgeOldNotifications() {
  const r = await db().query(`DELETE FROM community_notifications WHERE created_at < NOW() - INTERVAL '30 days' AND status IN ('sent','dead','suppressed')`);
  return { purged: r.rowCount };
}
