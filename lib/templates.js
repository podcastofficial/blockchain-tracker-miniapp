// Alert text templates: professional emoji layouts + {placeholder} rendering.
// - Built-in defaults live here. The admin panel can override any template (table alert_templates, see db/alert_templates.sql).
// - Syntax: {name} = value (HTML-escaped). A line that contains a placeholder with an EMPTY value is removed automatically,
//   so missing data never leaves a hole like "Fee: ". {name?} = optional: empty value is replaced by nothing, the line stays.
// - Telegram HTML is allowed in templates: <b> <i> <u> <code> <a href="https://..."> .
import { db } from "./db.js";

export const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export const H = html => ({ html: String(html ?? "") });                         // pre-built HTML value (inserted as is)

export const NET_EMOJI = { ethereum: "🔷", bsc: "🟡", polygon: "🟣", arbitrum: "🔵", base: "🟦", optimism: "🔴", avalanche: "🔺", tron: "🔻", solana: "🟪", ton: "💠" };
export const SEP = "━━━━━━━━━━━━━━━━━━";
const BRAND = "⚡ <b>Powered by Multi Blockchain Tracker</b>";

export const DEFAULT_TEMPLATES = {
  tx: {
    title: "Transaction report", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", status: "Success / Failed / Pending", status_icon: "✅ ❌ ⏳", hash: "Full transaction hash", block: "Block number", time: "Block time (UTC)",
      method: "Transfer / Contract interaction", from: "Sender (short)", from_link: "Sender (short, explorer link)", to: "Receiver (short)", to_link: "Receiver (short, explorer link)",
      from_full: "Sender (full)", to_full: "Receiver (full)", amount: "Amount with USD value", fee: "Network fee", updated: "Update time (UTC)", explorer_link: "Explorer link" },
    text:
`🧾 <b>Transaction</b> · {net_emoji} {network}
${SEP}
{status_icon} <b>Status:</b> {status}
🔖 <b>Hash:</b> <code>{hash}</code>
📦 <b>Block:</b> {block}
🕒 <b>Time:</b> {time}
⚙️ <b>Type:</b> {method}
${SEP}
📤 <b>From:</b> {from_link}
📥 <b>To:</b> {to_link}
💰 <b>Amount:</b> {amount}
⛽ <b>Fee:</b> {fee}
${SEP}
🔄 <i>Updated {updated}</i>
${BRAND}`
  },
  tx_notfound: {
    title: "Transaction not found", group: "Community · /track",
    vars: { hash: "Transaction hash", reason: "Why it was not found" },
    text:
`🧾 <b>Transaction lookup</b>
${SEP}
🔖 <code>{hash}</code>
⚠️ {reason}
${SEP}
${BRAND}`
  },
  address_wallet: {
    title: "Wallet detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", address: "Full address", balance: "Native balance with USD", stables: "Stablecoin balances (multi line)",
      notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`👛 <b>Wallet detected</b> · {net_emoji} {network}
${SEP}
📍 <b>Address</b>
<code>{address}</code>

💎 <b>Balance:</b> {balance}
{stables}
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Updated {updated}</i>
${BRAND}`
  },
  address_contract: {
    title: "Contract detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", address: "Full address", notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`📜 <b>Contract detected</b> · {net_emoji} {network}
${SEP}
📍 <b>Address</b>
<code>{address}</code>

🧩 <b>Type:</b> Smart contract / program
🔍 <b>Verification:</b> Not checked
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Updated {updated}</i>
${BRAND}`
  },
  address_token: {
    title: "Token detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", name: "Token name", symbol: "Token symbol", address: "Full address", price: "Price (USD)", change24h: "24h change",
      liquidity: "Liquidity (USD)", volume24h: "24h volume (USD)", market_cap: "Market cap / FDV", supply: "Supply", market_missing: "Shown only if no market data",
      notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`🪙 <b>Token detected</b> · {net_emoji} {network}
${SEP}
🏷 <b>{name}</b> ({symbol?})
📍 <code>{address}</code>

💲 <b>Price:</b> {price} {change24h?}
💧 <b>Liquidity:</b> {liquidity}
📊 <b>24h volume:</b> {volume24h}
🏦 <b>Market cap:</b> {market_cap}
📦 <b>Supply:</b> {supply}
⚠️ {market_missing}
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Updated {updated}</i>
${BRAND}`
  },
  token_trade: {
    title: "Token BUY / SELL alert", group: "Community · /watchcontract",
    vars: { side: "BUY or SELL", side_icon: "🟢 or 🔴", network: "Network name", net_emoji: "Network emoji", token_name: "Token name", token_symbol: "Token symbol",
      token_amount: "Token amount", quote_amount: "Quote amount", quote_symbol: "Quote symbol", trader: "Trader (short)", contract: "Token contract (full)", pair: "Pair (short)", tx_link: "Link to the transaction" },
    text:
`{side_icon} <b>TOKEN {side}</b> · {net_emoji} {network}
${SEP}
🪙 <b>{token_name}</b> ({token_symbol})

📦 <b>Token amount:</b> {token_amount}
💱 <b>Quote amount:</b> {quote_amount} {quote_symbol}
👤 <b>Trader:</b> <code>{trader}</code>
📜 <b>Contract:</b> <code>{contract}</code>
🔁 <b>Pair:</b> <code>{pair}</code>
${SEP}
🔎 {tx_link}
<i>On-chain DEX swap event · USD value not supplied by this RPC parser</i>
${BRAND}`
  }
};

/* ---------------------------------- rendering ---------------------------------- */
const has = v => v !== undefined && v !== null && (typeof v === "object" ? String(v.html ?? "") !== "" : String(v) !== "");
export function renderTemplate(text, vars = {}) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    let drop = false;
    const l = line.replace(/\{(\w+)(\?)?\}/g, (m, k, opt) => {
      const v = vars[k];
      if (!has(v)) { if (!opt) drop = true; return ""; }
      return typeof v === "object" ? String(v.html) : esc(v);
    });
    if (!drop) out.push(l);
  }
  return out.join("\n")
    .replace(/(━{6,})\n+(?=━{6,})/g, "")          // two separators in a row (a block in between was empty)
    .replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------------------------------- storage (admin overrides) ---------------------------------- */
let cache = { t: 0, map: {} };
export async function loadTemplates(force = false) {
  if (!force && Date.now() - cache.t < 30000) return cache.map;
  const map = {};
  try {
    const r = await db().query(`SELECT key, text FROM alert_templates`);
    for (const x of r.rows || []) if (DEFAULT_TEMPLATES[x.key] && typeof x.text === "string" && x.text.trim()) map[x.key] = x.text;
  } catch { /* table not created yet or DB unreachable: built-in defaults */ }
  cache = { t: Date.now(), map };
  return map;
}
export const clearTemplateCache = () => { cache.t = 0; };
export const tplText = (custom, key) => (custom && custom[key]) || DEFAULT_TEMPLATES[key].text;
export const renderKey = (key, vars, custom) => renderTemplate(tplText(custom, key), vars);
