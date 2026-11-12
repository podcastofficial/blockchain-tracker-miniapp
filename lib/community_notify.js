// Community Crypto Monitor — Phase 3: notification templates + durable queue.
// Flow: enqueue (deduplicated, rate-limited, persisted) -> send inline right away -> the 5-minute worker retries anything left over.
// Notifications are always delivered to the community row they were queued for (never to a chat id taken from elsewhere).
import { db } from "./db.js";
import { tgCall } from "./tgapi.js";
import { deepLink } from "./rich.js";
import { NETWORKS, explorerAddrLink, explorerTxLink } from "./address.js";
import { enrichAddress, enrichTx } from "./community_enrich.js";

export const MAX_ATTEMPTS = 5;
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const short = a => a && a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || "?");
export const fmtUsd = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "unavailable"
  : n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : n >= 1 ? "$" + Number(n).toFixed(2) : n === 0 ? "$0" : "$" + Number(n).toPrecision(3);
export const fmtAmt = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "unavailable"
  : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? Number(n.toFixed(4)).toString() : n === 0 ? "0" : Number(n.toPrecision(4)).toString();
const utc = t => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const FOOT = (d, sources) => `\n<i>${sources?.length ? "Source: " + esc(sources.join(" · ")) + " · " : ""}updated ${utc(d.updatedAt)}</i>\n— Powered by Multi Blockchain Tracker`;
const NOT_VERDICT = "<i>This is information only — not a safety verdict, audit or investment advice.</i>";

// Facts derived from DEX data. Labelled as notes, never as "safe" / "unsafe".
export function riskNotes(token) {
  if (!token) return [];
  const n = [];
  if (token.liquidity !== null && token.liquidity < 10000) n.push("Low liquidity (under $10k)");
  if (token.created) { const age = Date.now() - token.created; if (age < 86400000) n.push("Trading pair is less than 24h old"); else if (age < 7 * 86400000) n.push("Trading pair is less than 7 days old"); }
  if (!(token.websites?.length || token.socials?.length)) n.push("No website or social profile listed on DEX Screener");
  return n;
}

function buttons(rows) {
  const row = rows.filter(b => b.url && /^https:\/\//.test(b.url));
  return row.length ? { reply_markup: { inline_keyboard: [row] } } : {};
}

export function formatAddressNotification(d) {
  const net = NETWORKS[d.network].name, lines = [];
  const head = { wallet: "👛 <b>Wallet detected</b>", contract: "📜 <b>Contract detected</b>", token: "🪙 <b>Token detected</b>" }[d.kind] || "🔎 <b>Address detected</b>";
  lines.push(`${head} · ${net}`);
  if (d.kind === "token" && (d.name || d.symbol)) lines.push(`<b>${esc(d.name || d.symbol)}</b>${d.symbol && d.name ? " (" + esc(d.symbol) + ")" : ""}`);
  lines.push(`<code>${esc(d.address)}</code>`);
  if (d.kind === "wallet") {
    if (d.native) lines.push(`Balance: ${fmtAmt(d.native.amount)} ${esc(d.native.symbol)}${d.native.usd !== null ? " (~" + fmtUsd(d.native.usd) + ")" : ""}`);
    for (const s of d.stables || []) lines.push(`${esc(s.symbol)}: ${fmtAmt(s.amount)}`);
  } else if (d.kind === "contract") {
    lines.push("Type: smart contract / program", "Verification: not checked");
  } else if (d.kind === "token") {
    const t = d.token;
    if (t) {
      lines.push(`Price: ${t.priceUsd !== null ? fmtUsd(t.priceUsd) : "unavailable"}` + (t.change !== undefined && t.change?.h24 != null ? ` (24h ${t.change.h24 >= 0 ? "+" : ""}${Number(t.change.h24).toFixed(1)}%)` : ""));
      lines.push(`Liquidity: ${fmtUsd(t.liquidity)} · 24h volume: ${fmtUsd(t.volume?.h24 ?? t.volume)}`);
      lines.push(`Market cap: ${fmtUsd(t.marketCap ?? t.fdv)}`);
    } else lines.push("Price, liquidity and volume: unavailable");
    if (d.supply) lines.push(`Supply: ${fmtAmt(d.supply)}`);
  }
  for (const x of d.notes || []) lines.push("ℹ️ " + esc(x));
  if (d.unavailable?.length) lines.push("⚠️ Unavailable right now: " + esc(d.unavailable.join(", ")));
  const risks = riskNotes(d.token);
  if (risks.length) lines.push("", "<b>Notes</b>", ...risks.map(r => "• " + esc(r)));
  lines.push("", NOT_VERDICT);
  return { text: lines.join("\n") + FOOT(d, d.source), ...buttons([
    { text: "🔎 View on Explorer", url: explorerAddrLink(d.network, d.address) },
    d.token ? { text: "📈 Token Details", url: d.token.url } : {},
    { text: "📊 Open Tracker", url: deepLink("a_" + d.network) }]) };
}

export function formatTxNotification(d) {
  if (d.status === "not_found" || d.status === "unavailable" || !d.network) {
    const why = d.status === "unavailable" ? "I couldn't reach the network data source. Try again shortly." : "This transaction wasn't found on the enabled networks (it may be too new, pending in the mempool, or on another network).";
    return { text: `🧾 <b>Transaction lookup</b>\n<code>${esc(d.hash)}</code>\n${why}\n— Powered by Multi Blockchain Tracker` };
  }
  const st = { success: "✅ Success", failed: "❌ Failed", pending: "⏳ Pending" }[d.status] || d.status;
  const L = [`🧾 <b>Transaction</b> · ${NETWORKS[d.network].name}`, `Status: ${st}`, `Hash: <code>${esc(d.hash)}</code>`];
  if (d.block != null) L.push(`Block: ${d.block}`);
  if (d.time) L.push(`Time: ${utc(d.time)}`);
  if (d.from) L.push(`From: <code>${esc(short(d.from))}</code>`);
  if (d.to) L.push(`To: <code>${esc(short(d.to))}</code>`);
  if (d.value && d.value.amount > 0) L.push(`Amount: ${fmtAmt(d.value.amount)} ${esc(d.value.symbol)}`);
  if (d.fee) L.push(`Fee: ${fmtAmt(d.fee.amount)} ${esc(d.fee.symbol)}`);
  return { text: L.join("\n") + FOOT(d, []), ...buttons([{ text: "🔎 View on Explorer", url: explorerTxLink(d.network, d.hash) }, { text: "📊 Open Tracker", url: deepLink("a_" + d.network) }]) };
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
    const sub = n.subject; let msg, kind;
    if (sub.type === "tx") { const d = await enrichTx(sub.family, sub.hash, c.networks || []); kind = "tx"; msg = formatTxNotification(d); }
    else {
      const d = await enrichAddress(sub.network, sub.address); kind = d.kind;
      if (n.mode === "auto" && ((kind === "wallet" && c.detect_wallets === false) || (kind === "contract" && c.detect_contracts === false) || (kind === "token" && c.detect_tokens === false)))
        return void await finish(n.id, "suppressed", { error: "type_disabled", kind });
      msg = formatAddressNotification(d);
      if (sub.addressId) await db().query(`UPDATE community_addresses SET kind=$2 WHERE id=$1 AND $2 IN ('wallet','contract','token')`, [sub.addressId, kind]).catch(() => {});
    }
    const res = await tgCall("sendMessage", { chat_id: c.chat_id, text: msg.text, parse_mode: "HTML", disable_web_page_preview: true, ...(msg.reply_markup ? { reply_markup: msg.reply_markup } : {}),
      ...(n.reply_to_message_id ? { reply_to_message_id: Number(n.reply_to_message_id), allow_sending_without_reply: true } : {}) });
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
