// Community Crypto Monitor — Phase 2: automatic detection + /track commands for groups and channels.
// Replies show what is certain (valid format, network, explorer link). Live data (balances, token stats, risk) is Phase 3;
// nothing is invented and no ownership/legitimacy/safety claim is made.
import { db } from "./db.js";
import { tg, isChatAdmin } from "./tgapi.js";
import { deepLink } from "./rich.js";
import { NETWORKS, extractAddresses, resolveChains, explorerAddrLink } from "./address.js";

const short = a => a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const botName = () => String(process.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const HELP = "🤖 <b>Blockchain Tracker</b>\n" +
  "/track &lt;address&gt; – check a wallet, contract or token address\n" +
  "/trackinfo [address] – community status or address details\n" +
  "/tracklist – recent community addresses\n" +
  "/untrack &lt;address&gt; – remove (admins)\n" +
  "/pause · /resume – pause or resume monitoring (admins)\n\n" +
  "Supported: Ethereum, BNB Chain, Polygon, Arbitrum, Base, Solana, Tron.\n" +
  "Address format checks do not verify ownership, legitimacy or safety.";

async function loadCommunity(chatId) {
  const r = await db().query(
    `SELECT c.id, c.chat_id, c.chat_type, c.status, s.auto_detect, s.command_detect, s.networks, s.dedupe_window_minutes, s.max_notifications_per_hour
       FROM communities c LEFT JOIN community_settings s ON s.community_id=c.id WHERE c.chat_id=$1`, [chatId]);
  const c = r.rows[0]; if (!c) return null;
  return { ...c, auto_detect: c.auto_detect ?? true, command_detect: c.command_detect ?? true, networks: c.networks || [],
    dedupe_window_minutes: c.dedupe_window_minutes ?? 60, max_notifications_per_hour: c.max_notifications_per_hour ?? 30 };
}

// Atomic hourly counters. Returns true if one more reply is allowed this hour (and counts it).
async function takeReplySlot(community) {
  const r = await db().query(
    `INSERT INTO community_usage (community_id, hour_bucket, replies) VALUES ($1, date_trunc('hour', NOW()), 1)
     ON CONFLICT (community_id, hour_bucket) DO UPDATE SET replies = community_usage.replies + 1 RETURNING replies`, [community.id]);
  return r.rows[0].replies <= community.max_notifications_per_hour;
}
const countUsage = (id, scanned, addresses) => db().query(
  `INSERT INTO community_usage (community_id, hour_bucket, scanned, addresses) VALUES ($1, date_trunc('hour', NOW()), $2, $3)
   ON CONFLICT (community_id, hour_bucket) DO UPDATE SET scanned = community_usage.scanned + $2, addresses = community_usage.addresses + $3`,
  [id, scanned, addresses]).catch(() => {});

// Upsert one address/network. Returns { isNew, recentlySeen, id }. `recentlySeen` powers duplicate suppression for auto detection.
async function recordAddress(community, a, network, source, tgUser) {
  const r = await db().query(
    `INSERT INTO community_addresses (community_id, address, address_norm, family, network, status, source, submitted_by_telegram_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (community_id, address_norm, (COALESCE(network, ''))) DO UPDATE SET
       hit_count = community_addresses.hit_count + 1,
       status = CASE WHEN community_addresses.status='removed' AND EXCLUDED.status='active' THEN 'active' ELSE community_addresses.status END,
       last_seen_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, status,
       (SELECT last_seen_at FROM community_addresses WHERE community_id=$1 AND address_norm=$3 AND COALESCE(network,'')=COALESCE($5,'')) AS prev_seen`,
    [community.id, a.address, a.norm, a.family, network, network ? "active" : "pending_chain", source, tgUser ?? null]);
  const row = r.rows[0], prev = row.prev_seen ? new Date(row.prev_seen).getTime() : 0;
  return { id: row.id, isNew: row.is_new, status: row.status, recentlySeen: !row.is_new && Date.now() - prev < community.dedupe_window_minutes * 60000 };
}

function buttons(net, address) {
  const row = [];
  const link = explorerAddrLink(net, address); if (link) row.push({ text: "🔎 View on Explorer", url: link });
  const open = deepLink("a_" + net); if (open) row.push({ text: "📊 Open Tracker", url: open });
  return row.length ? { reply_markup: { inline_keyboard: [row] } } : {};
}
const resultText = (net, a) =>
  `🔎 <b>Address detected</b>\nNetwork: <b>${NETWORKS[net].name}</b>\nAddress: <code>${esc(a.address)}</code>\n` +
  `Format: valid ✅\nType, balance and risk data: not loaded yet\n<i>Format validity does not verify ownership, legitimacy or safety.</i>\n— Powered by Multi Blockchain Tracker`;

async function askChain(chatId, community, a, id, candidates, replyTo) {
  const rows = []; for (let i = 0; i < candidates.length; i += 2)
    rows.push(candidates.slice(i, i + 2).map(n => ({ text: NETWORKS[n].name, callback_data: `cm:${id}:${n}` })));
  return send(chatId, `🔎 <b>Which network?</b>\n<code>${esc(a.address)}</code>\nThis address format exists on several networks, so I won't guess.`,
    { reply_markup: { inline_keyboard: rows }, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) });
}

// Handle each address from a message. mode: 'auto' (silent on duplicates/disabled) or 'command' (always answers).
async function handleAddresses(community, m, addresses, mode, tgUser) {
  const chatId = m.chat.id; let replied = 0;
  for (const a of addresses) {
    const res = resolveChains(a.family, community.networks);
    if (res.status === "not_enabled") {
      if (mode === "command") await send(chatId, `⚠️ <code>${esc(short(a.address))}</code> looks like a ${a.family === "evm" ? "EVM" : a.family} address, but no matching network is enabled for this community.`);
      continue;
    }
    const net = res.status === "resolved" ? res.network : null;
    const rec = await recordAddress(community, a, net, mode, tgUser);
    if (mode === "auto" && rec.recentlySeen) continue;                  // duplicate suppression window
    if (!(await takeReplySlot(community))) break;                       // per-community hourly limit
    replied++;
    if (net) await send(chatId, resultText(net, a), { ...buttons(net, a.address), reply_to_message_id: m.message_id, allow_sending_without_reply: true });
    else await askChain(chatId, community, a, rec.id, res.candidates, m.message_id);
  }
  return replied;
}

function parseCommand(text) {
  const mt = /^\/([A-Za-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec((text || "").trim());
  if (!mt) return null;
  const target = (mt[2] || "").toLowerCase(), me = botName();
  if (target && me && target !== me) return null;                         // addressed to another bot in the group
  return { cmd: mt[1].toLowerCase(), args: (mt[3] || "").trim(), targeted: !!target };
}

// Channel posts carry no sender; only channel admins can post, so they count as authorized. Groups: verify live.
async function authorized(m) {
  if (m.chat.type === "channel") return true;
  return !!m.from?.id && await isChatAdmin(m.chat.id, m.from.id);
}

export async function processCommunityMessage(m) {
  if (m.from?.is_bot || m.via_bot) return;                                // never react to bots (prevents loops)
  const text = m.text || m.caption; if (!text) return;
  const community = await loadCommunity(m.chat.id);
  if (!community || community.status === "disconnected") return;
  const entities = m.entities || m.caption_entities || [];
  const chatId = m.chat.id, tgUser = m.from?.id;
  const cmd = parseCommand(text);

  if (cmd) {
    if (cmd.cmd === "help" || cmd.cmd === "start") return void await send(chatId, HELP);
    if (cmd.cmd === "resume") {
      if (!(await authorized(m))) return void await send(chatId, "Only chat admins can do that.");
      await db().query(`UPDATE communities SET status='active', updated_at=NOW() WHERE id=$1 AND status='paused'`, [community.id]);
      await db().query(`INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action) VALUES ($1,$2,$3,'community.resumed')`, [community.id, chatId, tgUser ?? null]);
      return void await send(chatId, "▶️ Monitoring resumed.");
    }
    if (community.status === "paused") return;
    if (cmd.cmd === "pause") {
      if (!(await authorized(m))) return void await send(chatId, "Only chat admins can do that.");
      await db().query(`UPDATE communities SET status='paused', updated_at=NOW() WHERE id=$1 AND status='active'`, [community.id]);
      await db().query(`INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action) VALUES ($1,$2,$3,'community.paused')`, [community.id, chatId, tgUser ?? null]);
      return void await send(chatId, "⏸ Monitoring paused. Use /resume to continue.");
    }
    const ex = extractAddresses(cmd.args, entities.map(e => ({ ...e, url: e.url })));
    if (cmd.cmd === "track") {
      if (!community.command_detect) return void await send(chatId, "Command detection is turned off for this community.");
      if (!ex.addresses.length) return void await send(chatId, ex.invalid.length ? "⚠️ That address failed its checksum — please check for typos." : "Usage: /track &lt;address&gt;  (EVM, Solana or Tron)");
      await countUsage(community.id, 1, ex.addresses.length);
      if (ex.truncated) await send(chatId, `Only the first ${ex.addresses.length} addresses are processed per message.`);
      return void await handleAddresses(community, m, ex.addresses, "command", tgUser);
    }
    if (cmd.cmd === "untrack") {
      if (!(await authorized(m))) return void await send(chatId, "Only chat admins can remove addresses.");
      if (!ex.addresses.length) return void await send(chatId, "Usage: /untrack &lt;address&gt;");
      const r = await db().query(`UPDATE community_addresses SET status='removed' WHERE community_id=$1 AND address_norm=$2 AND status<>'removed'`, [community.id, ex.addresses[0].norm]);
      await db().query(`INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action, metadata) VALUES ($1,$2,$3,'community.address_removed',$4)`, [community.id, chatId, tgUser ?? null, JSON.stringify({ address: ex.addresses[0].norm, rows: r.rowCount })]);
      return void await send(chatId, r.rowCount ? "🗑 Address removed from this community's list." : "That address isn't on this community's list.");
    }
    if (cmd.cmd === "tracklist") {
      const r = await db().query(`SELECT address, network, hit_count FROM community_addresses WHERE community_id=$1 AND status='active' ORDER BY last_seen_at DESC LIMIT 10`, [community.id]);
      return void await send(chatId, r.rowCount ? "📋 <b>Recent community addresses</b>\n" + r.rows.map(x => `• ${NETWORKS[x.network]?.name || x.network} <code>${esc(short(x.address))}</code> (${x.hit_count}×)`).join("\n") : "No addresses yet. Post one or use /track.");
    }
    if (cmd.cmd === "trackinfo") {
      if (ex.addresses.length) {
        const r = await db().query(`SELECT network, status, hit_count, first_seen_at FROM community_addresses WHERE community_id=$1 AND address_norm=$2 ORDER BY first_seen_at`, [community.id, ex.addresses[0].norm]);
        return void await send(chatId, r.rowCount ? `ℹ️ <code>${esc(short(ex.addresses[0].address))}</code>\n` + r.rows.map(x => `• ${NETWORKS[x.network]?.name || "network not chosen"} – ${x.status}, seen ${x.hit_count}×, first ${new Date(x.first_seen_at).toISOString().slice(0, 10)}`).join("\n") : "This community hasn't seen that address yet.");
      }
      const r = await db().query(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*) FILTER (WHERE status='pending_chain')::int AS pending FROM community_addresses WHERE community_id=$1`, [community.id]);
      return void await send(chatId, `ℹ️ <b>Community monitor</b>\nStatus: ${community.status}\nAuto detection: ${community.auto_detect ? "on" : "off"} · Commands: ${community.command_detect ? "on" : "off"}\nNetworks: ${community.networks.length ? community.networks.map(n => NETWORKS[n]?.name || n).join(", ") : "all supported"}\nAddresses: ${r.rows[0].active} active, ${r.rows[0].pending} awaiting network choice`);
    }
    return;                                                               // unknown command: stay quiet
  }

  // Automatic detection on normal messages / channel posts.
  if (community.status !== "active" || !community.auto_detect) return;
  const ex = extractAddresses(text, entities);
  await countUsage(community.id, 1, ex.addresses.length);
  if (!ex.addresses.length) return;
  await handleAddresses(community, m, ex.addresses, "auto", tgUser);
}

// Inline-button answer for ambiguous EVM addresses: callback_data = "cm:<community_addresses.id>:<network>".
export async function processCommunityCallback(q) {
  const mt = /^cm:(\d{1,18}):([a-z]{2,10})$/.exec(q.data || ""), chat = q.message?.chat;
  if (!mt || !chat) return;
  const [, id, net] = mt;
  const answer = text => tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: false });
  const community = await loadCommunity(chat.id);
  if (!community || community.status !== "active") return void await answer("Monitoring is not active.");
  const row = (await db().query(`SELECT * FROM community_addresses WHERE id=$1 AND community_id=$2 AND status='pending_chain'`, [id, community.id])).rows[0];
  if (!row) return void await answer("This choice has already been made.");
  const allowed = resolveChains(row.family, community.networks).candidates;
  if (!allowed.includes(net)) return void await answer("Network not available here.");
  if (!(row.submitted_by_telegram_id && row.submitted_by_telegram_id === q.from.id) && !(await isChatAdmin(chat.id, q.from.id)))
    return void await answer("Only the submitter or an admin can choose.");
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const ex = await c.query(`SELECT id FROM community_addresses WHERE community_id=$1 AND address_norm=$2 AND network=$3 FOR UPDATE`, [community.id, row.address_norm, net]);
    if (ex.rowCount) { await c.query(`UPDATE community_addresses SET hit_count=hit_count+1, status='active', last_seen_at=NOW() WHERE id=$1`, [ex.rows[0].id]); await c.query(`DELETE FROM community_addresses WHERE id=$1`, [row.id]); }
    else await c.query(`UPDATE community_addresses SET network=$2, status='active', last_seen_at=NOW() WHERE id=$1`, [row.id, net]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); await answer("Something went wrong, try again."); return; } finally { c.release(); }
  await answer(NETWORKS[net].name + " selected");
  await tg("editMessageText", { chat_id: chat.id, message_id: q.message.message_id, parse_mode: "HTML", disable_web_page_preview: true,
    text: resultText(net, { address: row.address }), ...buttons(net, row.address) });
}
