// Unified tracking for EVERY chat type: private chat, group/supergroup and channel.
//   /watchwallet   <network> <address> [minUSD]  -> incoming + outgoing transfers of a wallet
//   /watchactivity <network> <address>           -> smart-contract activity (privileged actions, calls, swaps, transfers)
//   /watchcontract <network> <token>  (= /watchtoken) -> DEX BUY / SELL alerts for a token contract
//   /watchlist · /unwatch <id>                   -> manage
// Alerts are posted into the same chat where the command was sent. Private chats need no admin rights; in groups
// only admins may add/remove; channel posts are admin-only by Telegram design.
import { db } from "./db.js";
import { tg, tgCall, isChatAdmin } from "./tgapi.js";
import { NETWORKS, extractAddresses, extractTxHashes, resolveChains } from "./address.js";
import { EVM } from "./balances.js";
import { scanRule } from "./onchain.js";
import { deepLink } from "./rich.js";
import { enrichAddress, enrichTx } from "./community_enrich.js";
import { formatAddressNotification, formatTxNotification } from "./community_notify.js";
import { loadTemplates } from "./templates.js";

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const short = a => (a && a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const NAME = { ethereum: "Ethereum", bsc: "BNB Chain", polygon: "Polygon", arbitrum: "Arbitrum", base: "Base", optimism: "Optimism", avalanche: "Avalanche", tron: "Tron", solana: "Solana" };
const ALIAS = { eth: "ethereum", ethereum: "ethereum", bnb: "bsc", bsc: "bsc", bnbchain: "bsc", matic: "polygon", pol: "polygon", polygon: "polygon",
  arb: "arbitrum", arbitrum: "arbitrum", base: "base", op: "optimism", optimism: "optimism", avax: "avalanche", avalanche: "avalanche",
  trx: "tron", tron: "tron", sol: "solana", solana: "solana" };
const EVM_NETS = Object.keys(EVM);
const WALLET_NETS = [...EVM_NETS, "tron", "solana"];
const famOf = n => (EVM[n] ? "evm" : n);                       // evm | tron | solana
const explorer = { ethereum: "https://etherscan.io/address/", bsc: "https://bscscan.com/address/", polygon: "https://polygonscan.com/address/", arbitrum: "https://arbiscan.io/address/",
  base: "https://basescan.org/address/", optimism: "https://optimistic.etherscan.io/address/", avalanche: "https://snowtrace.io/address/", tron: "https://tronscan.org/#/address/", solana: "https://solscan.io/account/" };

export const WATCH_CMDS = new Set(["watchwallet", "watchactivity", "watchcontract", "watchtoken", "watchlist", "contractlist", "unwatch", "unwatchcontract"]);

export const WATCH_HELP = "👛 /watchwallet &lt;network&gt; &lt;address&gt; – incoming &amp; outgoing transactions of a wallet\n" +
  "⌘ /watchactivity &lt;network&gt; &lt;contract&gt; – smart-contract activity\n" +
  "🔄 /watchcontract &lt;network&gt; &lt;token&gt; – token BUY / SELL alerts\n" +
  "📋 /watchlist · /unwatch &lt;id&gt; – see and remove watches\n" +
  "Networks: ethereum, bsc, polygon, arbitrum, base, optimism, avalanche, tron, solana (Tron/Solana addresses need no network).";

export const BOT_COMMANDS = [
  { command: "track", description: "Look up an address, token or transaction" },
  { command: "watchwallet", description: "Alert on a wallet's incoming/outgoing transactions" },
  { command: "watchactivity", description: "Alert on smart-contract activity" },
  { command: "watchcontract", description: "Alert on token BUY/SELL" },
  { command: "watchlist", description: "Show active watches" },
  { command: "unwatch", description: "Remove a watch" },
  { command: "trackinfo", description: "Status / details of an address" },
  { command: "settings", description: "Open settings" },
  { command: "price", description: "Live price, e.g. /price btc" },
  { command: "alerts", description: "Your active alerts" },
  { command: "help", description: "All commands" }
];

// ---------- parsing ----------
export function parseTarget(args) {
  const words = String(args || "").trim().split(/\s+/).filter(Boolean);
  let network = null, minUsd = null;
  for (const w of words) {
    const k = ALIAS[w.toLowerCase()];
    if (k && !network) network = k;
    else if (/^\d+(\.\d+)?$/.test(w) && minUsd === null) minUsd = Number(w);
  }
  const ex = extractAddresses(args || "");
  const a = ex.addresses[0] || null;
  if (a && !network && a.family !== "evm") network = a.family;
  return { network, minUsd, a, invalid: ex.invalid.length > 0 };
}

const CAP = type => (type === "private" ? 10 : 25);
async function countWatches(chatId) {
  const r = await db().query(
    `SELECT (SELECT COUNT(*) FROM chat_watches WHERE chat_id=$1 AND status<>'removed')::int AS a,
            (SELECT COUNT(*) FROM community_contract_watches WHERE chat_id=$1 AND status<>'removed')::int AS b`, [chatId]);
  return r.rows[0].a + r.rows[0].b;
}

// ---------- add ----------
// mode: wallet | activity | token. Returns { ok, text } (HTML).
export async function addWatch({ chatId, chatType, tgUser }, mode, p) {
  const { network, a } = p;
  const need = mode === "wallet" ? WALLET_NETS : EVM_NETS;
  const label = mode === "wallet" ? "wallet" : mode === "activity" ? "contract" : "token";
  if (!a) return { ok: false, text: p.invalid ? "⚠️ That address failed its checksum — please check for typos." : `Usage: /${mode === "wallet" ? "watchwallet" : mode === "activity" ? "watchactivity" : "watchcontract"} &lt;network&gt; &lt;${label} address&gt;\nExample: <code>/${mode === "wallet" ? "watchwallet" : mode === "activity" ? "watchactivity" : "watchcontract"} bsc 0x…</code>` };
  if (!network) return { ok: false, text: `Which network? This 0x address exists on several chains.\nExample: <code>/${mode === "wallet" ? "watchwallet" : "watchcontract"} bsc ${esc(a.address)}</code>\nNetworks: ${EVM_NETS.join(", ")}` };
  if (!need.includes(network)) return { ok: false, text: `${NAME[network] || network} isn't supported for ${mode === "wallet" ? "wallet" : "contract/token"} watching. Supported: ${need.join(", ")}.` };
  if (famOf(network) !== a.family) return { ok: false, text: `That address isn't a ${NAME[network]} address.` };
  if ((await countWatches(chatId)) >= CAP(chatType)) return { ok: false, text: `This chat reached its limit of ${CAP(chatType)} watches. Remove one with /unwatch &lt;id&gt;.` };
  const where = `${NAME[network]} · <code>${esc(short(a.address))}</code>`;

  if (mode === "token") {
    const com = (await db().query(`SELECT id FROM communities WHERE chat_id=$1 AND status<>'disconnected'`, [chatId])).rows[0];
    const ex = (await db().query(`SELECT id, status FROM community_contract_watches WHERE chat_id=$1 AND network=$2 AND token_norm=$3`, [chatId, network, a.address.toLowerCase()])).rows[0];
    let id;
    if (ex) {
      id = ex.id;
      if (["removed", "error"].includes(ex.status)) await db().query(`UPDATE community_contract_watches SET status='discovering', last_error=NULL, updated_at=NOW() WHERE id=$1`, [id]);
      else return { ok: true, text: `ℹ️ Already watching BUY/SELL for ${where} (ID <b>T${id}</b>).` };
    } else {
      id = (await db().query(
        `INSERT INTO community_contract_watches(community_id,chat_id,network,token_address,token_norm,created_by,status) VALUES($1,$2,$3,$4,$5,$6,'discovering') RETURNING id`,
        [com?.id ?? null, chatId, network, a.address, a.address.toLowerCase(), tgUser || null])).rows[0].id;
    }
    return { ok: true, text: `✅ <b>Token BUY/SELL alerts on</b>\n${where}\nID: <b>T${id}</b>\nI'll find the main liquidity pair on the next scan, then post every BUY 🟢 and SELL 🔴 here (no old history).` };
  }

  const kind = mode === "wallet" ? "wallet" : "contract";
  const minUsd = kind === "wallet" ? (p.minUsd && p.minUsd > 1 ? p.minUsd : 1) : 1;
  const r = await db().query(
    `INSERT INTO chat_watches(chat_id,chat_type,kind,network,address,address_norm,min_usd,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (chat_id,kind,network,address_norm) DO UPDATE SET status='active', last_error=NULL, min_usd=EXCLUDED.min_usd, state=CASE WHEN chat_watches.status='removed' THEN '{}'::jsonb ELSE chat_watches.state END
     RETURNING id, (xmax = 0) AS inserted`,
    [chatId, chatType, kind, network, a.address, famOf(network) === "evm" ? a.address.toLowerCase() : a.address, minUsd, tgUser || null]);
  const id = r.rows[0].id;
  return kind === "wallet"
    ? { ok: true, text: `✅ <b>Wallet watch on</b>\n${where}\nID: <b>W${id}</b>\nI'll post every incoming ⬇️ and outgoing ⬆️ transaction here${minUsd > 1 ? ` (≥ $${minUsd})` : ""}. Tracking starts now — no old history.` }
    : { ok: true, text: `✅ <b>Smart-contract watch on</b>\n${where}\nID: <b>W${id}</b>\nI'll post contract activity here (ownership/upgrade/pause/role changes and other calls). Tracking starts now.` };
}

// ---------- list / remove ----------
async function listText(chatId) {
  const w = (await db().query(`SELECT id, kind, network, address, status FROM chat_watches WHERE chat_id=$1 AND status<>'removed' ORDER BY id LIMIT 40`, [chatId])).rows;
  const t = (await db().query(`SELECT id, network, token_address, token_symbol, status FROM community_contract_watches WHERE chat_id=$1 AND status<>'removed' ORDER BY id LIMIT 40`, [chatId])).rows;
  if (!w.length && !t.length) return "No watches in this chat yet.\n\n" + WATCH_HELP;
  const lines = [
    ...w.map(x => `W${x.id} ${x.kind === "wallet" ? "👛 Wallet" : "⌘ Contract"} · ${NAME[x.network] || x.network} · <code>${esc(short(x.address))}</code>${x.status === "paused" ? " · ⏸" : ""}`),
    ...t.map(x => `T${x.id} 🔄 Buy/Sell · ${NAME[x.network] || x.network} · <code>${esc(short(x.token_address))}</code>${x.token_symbol ? " · " + esc(x.token_symbol) : ""}${x.status === "error" ? " · ⚠️" : ""}`)
  ];
  return "📡 <b>Watches in this chat</b>\n" + lines.join("\n") + "\n\nRemove: /unwatch W12 or /unwatch T5";
}
async function removeWatch(chatId, arg) {
  const mt = /^([WTwt]?)(\d{1,18})$/.exec(String(arg || "").trim());
  if (!mt) return "Usage: /unwatch &lt;id&gt;  (e.g. W12 or T5 — see /watchlist)";
  const kind = (mt[1] || "T").toUpperCase(), id = mt[2];
  const r = kind === "W"
    ? await db().query(`UPDATE chat_watches SET status='removed' WHERE id=$1 AND chat_id=$2 AND status<>'removed'`, [id, chatId])
    : await db().query(`UPDATE community_contract_watches SET status='removed', updated_at=NOW() WHERE id=$1 AND chat_id=$2 AND status<>'removed'`, [id, chatId]);
  return r.rowCount ? "🗑 Watch removed." : "That ID isn't in this chat. See /watchlist.";
}

// ---------- command entry (all chat types) ----------
// ctx: { chatId, chatType, tgUser, canManage: async () => boolean }
export async function handleWatchCommand(ctx, cmd, args) {
  const reply = (text, extra) => send(ctx.chatId, text, extra);
  if (cmd === "watchlist" || cmd === "contractlist") { await reply(await listText(ctx.chatId)); return true; }
  if (!(await ctx.canManage())) { await reply("Only chat admins can add or remove watches here."); return true; }
  if (cmd === "unwatch" || cmd === "unwatchcontract") { await reply(await removeWatch(ctx.chatId, args)); return true; }
  const mode = cmd === "watchwallet" ? "wallet" : cmd === "watchactivity" ? "activity" : "token";
  const res = await addWatch(ctx, mode, parseTarget(args));
  await reply(res.text);
  return true;
}

// ---------- inline buttons: cw:<l|w|a|t>:<network>:<address> ----------
export async function handleWatchCallback(q) {
  const mt = /^cw:([lwat]):([a-z]{3,10}):(\S{20,64})$/.exec(q.data || ""), chat = q.message?.chat;
  if (!mt || !chat) return;
  const answer = text => tgCall("answerCallbackQuery", { callback_query_id: q.id, text: String(text).slice(0, 190) });
  const [, act, network, address] = mt;
  const a = extractAddresses(address).addresses[0];
  if (!a || !WALLET_NETS.includes(network) || famOf(network) !== a.family) return void await answer("Invalid address.");
  const isPrivate = chat.type === "private";
  if (act !== "l" && !isPrivate && chat.type !== "channel" && !(await isChatAdmin(chat.id, q.from.id))) return void await answer("Only chat admins can do that.");
  await answer("Working…");
  if (act === "l") return void await lookupAddress(chat.id, network, a.address);
  const res = await addWatch({ chatId: chat.id, chatType: chat.type, tgUser: q.from.id }, act === "w" ? "wallet" : act === "a" ? "activity" : "token", { network, a });
  await send(chat.id, res.text);
}

// ---------- private chat: /track /tx /trackinfo /settings ----------
const watchKeyboard = (network, address) => {
  const rows = [[{ text: "👛 Watch wallet", callback_data: `cw:w:${network}:${address}` }]];
  if (EVM[network]) rows.push([{ text: "⌘ Contract activity", callback_data: `cw:a:${network}:${address}` }, { text: "🔄 Buy/Sell alerts", callback_data: `cw:t:${network}:${address}` }]);
  return rows;
};
async function lookupAddress(chatId, network, address) {
  const d = await enrichAddress(network, address);
  const msg = formatAddressNotification(d, { templates: await loadTemplates() });
  const rows = [...(msg.reply_markup?.inline_keyboard || []), ...(WALLET_NETS.includes(network) ? watchKeyboard(network, address) : [])];
  await send(chatId, msg.text, { reply_markup: { inline_keyboard: rows } });
}
async function lookupTx(chatId, t) {
  const d = await enrichTx(t.family, t.hash, []);
  const msg = formatTxNotification(d, { templates: await loadTemplates() });
  await send(chatId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {});
}
const appRows = () => (/^https:\/\//.test(process.env.MINIAPP_URL || "") ? [[{ text: "📊 Open Blockchain Tracker", web_app: { url: process.env.MINIAPP_URL } }]] : []);

// Returns true when the command was handled (so bot.js stops).
export async function handlePrivateCommand(m, cmd, args) {
  const chatId = m.chat.id, ctx = { chatId, chatType: "private", tgUser: m.from?.id, canManage: async () => true };
  if (WATCH_CMDS.has(cmd)) return handleWatchCommand(ctx, cmd, args);
  if (cmd === "track" || cmd === "tx") {
    let src = args;
    const rep = m.reply_to_message, repText = rep && (rep.text || rep.caption);
    let ex = extractAddresses(src), txs = extractTxHashes(src, { allowPlainHex: true });
    if (!ex.addresses.length && !txs.length && repText) { src = repText; ex = extractAddresses(repText); txs = extractTxHashes(repText, { allowPlainHex: cmd === "tx" }); }
    const addrs = cmd === "tx" ? [] : ex.addresses;
    if (!addrs.length && !txs.length) { await send(chatId, ex.invalid.length ? "⚠️ That address failed its checksum — please check for typos." : "Usage: /track &lt;address or tx hash&gt;  (EVM, Solana or Tron) — or reply to a message with /track"); return true; }
    for (const a of addrs.slice(0, 3)) {
      const res = resolveChains(a.family, []);
      if (res.status === "resolved") await lookupAddress(chatId, res.network, a.address);
      else if (res.status === "ambiguous") {
        const rows = []; for (let i = 0; i < res.candidates.length; i += 2) rows.push(res.candidates.slice(i, i + 2).map(n => ({ text: NETWORKS[n].name, callback_data: `cw:l:${n}:${a.address}` })));
        await send(chatId, `🔎 <b>Which network?</b>\n<code>${esc(a.address)}</code>\nThis address format exists on several networks, so I won't guess.`, { reply_markup: { inline_keyboard: rows } });
      }
    }
    for (const t of txs.slice(0, 2)) await lookupTx(chatId, t);
    return true;
  }
  if (cmd === "trackinfo") {
    const ex = extractAddresses(args).addresses[0];
    if (ex) {
      const w = (await db().query(`SELECT id, kind, network FROM chat_watches WHERE chat_id=$1 AND status<>'removed' AND address_norm=$2`, [chatId, ex.family === "evm" ? ex.address.toLowerCase() : ex.address])).rows;
      const t = (await db().query(`SELECT id, network FROM community_contract_watches WHERE chat_id=$1 AND status<>'removed' AND token_norm=$2`, [chatId, ex.address.toLowerCase()])).rows;
      const lines = [...w.map(x => `W${x.id} ${x.kind === "wallet" ? "👛 wallet" : "⌘ contract"} · ${NAME[x.network] || x.network}`), ...t.map(x => `T${x.id} 🔄 buy/sell · ${NAME[x.network] || x.network}`)];
      await send(chatId, `ℹ️ <code>${esc(short(ex.address))}</code>\n` + (lines.length ? lines.join("\n") : "Not watched in this chat yet. Use /watchwallet, /watchactivity or /watchcontract."));
    } else {
      const n = await countWatches(chatId);
      await send(chatId, `ℹ️ <b>Your tracker</b>\nActive watches: ${n} / ${CAP("private")}\n\n${WATCH_HELP}\n\n/watchlist – see them all`);
    }
    return true;
  }
  if (cmd === "settings") {
    const n = await countWatches(chatId);
    await send(chatId, `⚙️ <b>Settings</b>\nActive watches in this chat: ${n} / ${CAP("private")}\nAlerts, limits and themes are managed in the Mini App. Use /watchlist and /unwatch here.`, appRows().length ? { reply_markup: { inline_keyboard: appRows() } } : {});
    return true;
  }
  return false;
}

// ---------- scanner (cron) ----------
const PERMANENT = /chat not found|bot was kicked|bot is not a member|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|bot was blocked|channel_private|user is deactivated/i;
async function post(chatId, html, text) {
  const base = { chat_id: chatId, disable_web_page_preview: true };
  if (html) {
    const r = await tgCall("sendMessage", { ...base, text: html, parse_mode: "HTML" });
    if (r.ok || !(r.error_code === 400 && /parse entities|can't parse/i.test(String(r.description)))) return r;
  }
  return tgCall("sendMessage", { ...base, text });
}

export async function scanChatWatches(budgetMs = 45000) {
  const started = Date.now();
  await db().query(`DELETE FROM chat_watch_events WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => {});
  const rows = (await db().query(
    `SELECT w.id, w.chat_id, w.kind, w.network, w.address, w.min_usd::float8 AS min_usd, w.state
       FROM chat_watches w LEFT JOIN communities c ON c.chat_id=w.chat_id
      WHERE w.status='active' AND (w.chat_type='private' OR (c.status='active' AND c.can_post=TRUE))
      ORDER BY w.last_run_at NULLS FIRST LIMIT 30`)).rows;
  let events = 0, errors = 0;
  const work = async w => {
    if (Date.now() - started > budgetMs) return;
    try {
      const { state, events: ev } = await scanRule({ kind: w.kind, network: w.network, address: w.address, min_usd: w.min_usd, state: w.state });
      let pushed = 0, failed = false;
      for (const e of ev) {
        const ins = await db().query(`INSERT INTO chat_watch_events(watch_id, tx_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING watch_id`, [w.id, e.key]);
        if (!ins.rowCount) continue;
        if (pushed >= 8) continue;                                          // per-scan burst cap; the explorer link has the rest
        const r = await post(w.chat_id, e.html, e.summary);
        if (r.ok) { pushed++; events++; continue; }
        await db().query(`DELETE FROM chat_watch_events WHERE watch_id=$1 AND tx_key=$2`, [w.id, e.key]);   // retry on the next run
        if (r.error_code === 429) { failed = true; break; }
        if ((r.error_code === 400 || r.error_code === 403) && PERMANENT.test(String(r.description || ""))) {
          await db().query(`UPDATE chat_watches SET status='paused', last_error=$2 WHERE chat_id=$1 AND status='active'`, [w.chat_id, String(r.description).slice(0, 120)]);
          return;
        }
        failed = true; break;
      }
      if (failed) { await db().query(`UPDATE chat_watches SET last_run_at=NOW(), last_error='SEND_FAILED' WHERE id=$1`, [w.id]); errors++; return; }   // keep old state: events re-scan next run
      await db().query(`UPDATE chat_watches SET state=$2, last_run_at=NOW(), last_error=NULL WHERE id=$1`, [w.id, JSON.stringify(state)]);
    } catch (err) {
      errors++;
      await db().query(`UPDATE chat_watches SET last_run_at=NOW(), last_error=$2 WHERE id=$1`, [w.id, String(err?.message || "SCAN_FAILED").slice(0, 80)]).catch(() => {});
    }
  };
  for (let i = 0; i < rows.length; i += 5) await Promise.all(rows.slice(i, i + 5).map(work));
  return { watches: rows.length, events, errors };
}
