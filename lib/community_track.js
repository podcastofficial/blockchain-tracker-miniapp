// Community Crypto Monitor — Phase 2: automatic detection + /track commands for groups and channels.
// Replies show what is certain (valid format, network, explorer link). Live data (balances, token stats, risk) is Phase 3;
// nothing is invented and no ownership/legitimacy/safety claim is made.
import { db } from "./db.js";
import { tg, isChatAdmin } from "./tgapi.js";
import { deepLink } from "./rich.js";
import { NETWORKS, extractAddresses, extractTxHashes, resolveChains } from "./address.js";
import { enqueueNotification, processNow } from "./community_notify.js";

const short = a => a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const botName = () => String(process.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const HELP = "🤖 <b>Blockchain Tracker</b>\n" +
  "/track &lt;address or tx hash&gt; – look up a wallet, contract, token or transaction\n" +
  "/trackinfo [address] – community status or address details\n" +
  "/tracklist – recent community addresses\n" +
  "/tx &lt;hash&gt; – transaction status\n" +
  "/untrack &lt;address&gt; – remove (admins)\n" +
  "/pause · /resume – pause or resume monitoring (admins)\n" +
  "/settings – open the admin settings (admins)\n\n" +
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

async function askChain(chatId, community, a, id, candidates, replyTo) {
  const rows = []; for (let i = 0; i < candidates.length; i += 2)
    rows.push(candidates.slice(i, i + 2).map(n => ({ text: NETWORKS[n].name, callback_data: `cm:${id}:${n}` })));
  return send(chatId, `🔎 <b>Which network?</b>\n<code>${esc(a.address)}</code>\nThis address format exists on several networks, so I won't guess.`,
    { reply_markup: { inline_keyboard: rows }, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) });
}

// Dedupe key: auto = one per (address, network) per dedupe window; command/choice = one per Telegram message / button press,
// so a deliberate /track is always answered but a retried webhook can never double-post.
const windowKey = (community, mode, extra) => mode === "auto" ? `w${Math.floor(Date.now() / (community.dedupe_window_minutes * 60000))}` : extra;

// Handle each address / tx hash from a message. mode: 'auto' (silent on duplicates) or 'command' (always answers).
async function handleSubjects(community, m, { addresses = [], txs = [] }, mode, tgUser) {
  const chatId = m.chat.id, ids = [];
  for (const a of addresses) {
    const res = resolveChains(a.family, community.networks);
    if (res.status === "not_enabled") {
      if (mode === "command") await send(chatId, `⚠️ <code>${esc(short(a.address))}</code> looks like a ${a.family === "evm" ? "EVM" : a.family} address, but no matching network is enabled for this community.`);
      continue;
    }
    const net = res.status === "resolved" ? res.network : null;
    const rec = await recordAddress(community, a, net, mode, tgUser);
    if (mode === "auto" && rec.recentlySeen) continue;                  // sliding-window duplicate suppression
    if (!net) { await askChain(chatId, community, a, rec.id, res.candidates, m.message_id); continue; }
    const id = await enqueueNotification(community, { type: "address", family: a.family, address: a.address, norm: a.norm, network: net, addressId: rec.id },
      { mode, replyTo: m.message_id, key: `addr:${net}:${a.norm}:${windowKey(community, mode, "m" + m.message_id)}` });
    if (id) ids.push(id);
  }
  for (const t of txs) {
    if (resolveChains(t.family, community.networks).status === "not_enabled") {
      if (mode === "command") await send(chatId, `⚠️ No ${t.family === "evm" ? "EVM" : t.family} network is enabled for this community, so I can't look up that transaction.`);
      continue;
    }
    const id = await enqueueNotification(community, { type: "tx", family: t.family, hash: t.hash, norm: t.norm },
      { mode, replyTo: m.message_id, key: `tx:${t.norm}:${windowKey(community, mode, "m" + m.message_id)}` });
    if (id) ids.push(id);
  }
  await processNow(ids);                                                // send now; anything unfinished is retried by the worker
  return ids.length;
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
    if (cmd.cmd === "settings") {
      // Verifies the sender live and remembers them as an admin so the Mini App lists this community for them.
      if (m.chat.type !== "channel") {
        if (!tgUser || !(await isChatAdmin(chatId, tgUser))) return void await send(chatId, "Only chat admins can open settings.");
        await db().query(`INSERT INTO community_admins (community_id, telegram_user_id, role) VALUES ($1,$2,'administrator') ON CONFLICT (community_id, telegram_user_id) DO UPDATE SET synced_at=NOW()`, [community.id, tgUser]);
      }
      const link = deepLink("cm_" + community.id);
      return void await send(chatId, "⚙️ Community settings are managed in the Mini App by chat admins.", link ? { reply_markup: { inline_keyboard: [[{ text: "⚙️ Open settings", url: link }]] } } : {});
    }
    if (community.status === "paused") return;
    if (cmd.cmd === "pause") {
      if (!(await authorized(m))) return void await send(chatId, "Only chat admins can do that.");
      await db().query(`UPDATE communities SET status='paused', updated_at=NOW() WHERE id=$1 AND status='active'`, [community.id]);
      await db().query(`INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action) VALUES ($1,$2,$3,'community.paused')`, [community.id, chatId, tgUser ?? null]);
      return void await send(chatId, "⏸ Monitoring paused. Use /resume to continue.");
    }
    const ex = extractAddresses(cmd.args, entities), txs = extractTxHashes(cmd.args, { allowPlainHex: true });
    if (cmd.cmd === "track" || cmd.cmd === "tx") {
      if (!community.command_detect) return void await send(chatId, "Command detection is turned off for this community.");
      const addrs = cmd.cmd === "tx" ? [] : ex.addresses;
      if (!addrs.length && !txs.length) return void await send(chatId, ex.invalid.length ? "⚠️ That address failed its checksum — please check for typos." : cmd.cmd === "tx" ? "Usage: /tx &lt;transaction hash&gt;" : "Usage: /track &lt;address or transaction hash&gt;  (EVM, Solana or Tron)");
      await countUsage(community.id, 1, addrs.length + txs.length);
      if (ex.truncated) await send(chatId, `Only the first ${ex.addresses.length} addresses are processed per message.`);
      return void await handleSubjects(community, m, { addresses: addrs, txs }, "command", tgUser);
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

  // Automatic detection on normal messages / channel posts (addresses + EVM/Solana transaction hashes).
  if (community.status !== "active" || !community.auto_detect) return;
  const ex = extractAddresses(text, entities), txs = extractTxHashes(text);
  await countUsage(community.id, 1, ex.addresses.length + txs.length);
  if (!ex.addresses.length && !txs.length) return;
  await handleSubjects(community, m, { addresses: ex.addresses, txs }, "auto", tgUser);
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
    text: `✅ <b>${NETWORKS[net].name}</b> selected for <code>${esc(short(row.address))}</code> — loading details…` });
  const nid = await enqueueNotification(community, { type: "address", family: row.family, address: row.address, norm: row.address_norm, network: net, addressId: row.id },
    { mode: "choice", replyTo: q.message.message_id, key: `addr:${net}:${row.address_norm}:choice${row.id}` });
  if (nid) await processNow([nid]);
}
