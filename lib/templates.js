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

Object.assign(DEFAULT_TEMPLATES, {
  price_update: {
    title: "Price update (scheduled)", group: "Channel alerts",
    vars: { network: "Blockchain / Crypto", coins: "Coin cards (price + 1h/4h/8h/24h)", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`📈 <b>{network} price update</b>
${SEP}
{coins}
${SEP}
{more}
🕒 {time}
${BRAND}`
  },
  price_move: {
    title: "Price move (only on change)", group: "Channel alerts",
    vars: { network: "Blockchain / Crypto", coins: "Coin cards incl. “since last alert”", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`🚨 <b>{network} price move</b>
${SEP}
{coins}
${SEP}
{more}
🕒 {time}
${BRAND}`
  },
  movers: {
    title: "Top gainers & losers", group: "Channel alerts",
    vars: { gainers: "Gainer lines", losers: "Loser lines", time: "Post time (UTC)" },
    text:
`🚀 <b>Top gainers</b>
{gainers}

💥 <b>Top losers</b>
{losers}
${SEP}
🕒 {time}
${BRAND}`
  },
  trending: {
    title: "Trending coins", group: "Channel alerts",
    vars: { coins: "Coin cards", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`🔥 <b>Trending coins</b>
${SEP}
{coins}
${SEP}
{more}
🕒 {time}
${BRAND}`
  },
  new_token: {
    title: "New token (one block per token)", group: "Channel alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", name: "Token name", symbol: "Token symbol", price: "Price (USD)", liquidity: "Liquidity (USD)", fdv: "FDV (USD)", age: "Pair age", link: "DEX Screener link" },
    text:
`🆕 <b>New token</b> · {net_emoji} {network}
${SEP}
🏷 <b>{name}</b> ({symbol?})
💰 <b>Price:</b> {price}
💧 <b>Liquidity:</b> {liquidity}
🏦 <b>FDV:</b> {fdv}
⏱ <b>Pair created:</b> {age}
🔗 {link}`
  },
  new_token_footer: {
    title: "New token (footer, once per post)", group: "Channel alerts",
    vars: {},
    text:
`${SEP}
⚠️ <i>New tokens are high risk. Always do your own research.</i>
${BRAND}`
  },
  liquidity: {
    title: "Liquidity alert (drop / added / low)", group: "Channel alerts",
    vars: { headline: "🚨 LIQUIDITY REMOVED / ⚠️ Liquidity drop / 💧 added / 🔻 low", token: "Token + network", detail: "Before → after (change) or limit", link: "DEX Screener link", time: "Post time (UTC)" },
    text:
`{headline}
${SEP}
🪙 <b>{token}</b>
📊 {detail}
🔗 {link}
${SEP}
🕒 {time}`
  },
  whale: {
    title: "Whale transfer", group: "Channel & personal alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", amount: "Amount + token", from: "Sender (short)", to: "Receiver (short)", tx_link: "Link to the transaction" },
    text:
`🐋 <b>Whale transfer</b> · {net_emoji} {network}
${SEP}
💰 <b>Amount:</b> {amount}
📤 <b>From:</b> {from}
📥 <b>To:</b> {to}
${SEP}
🔎 {tx_link}
${BRAND}`
  },
  wallet_move: {
    title: "Wallet activity (received / sent)", group: "Personal alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", wallet_link: "Your wallet (short, explorer link)", direction: "Received / Sent", direction_icon: "⬇️ or ⬆️", amount: "Amount (+ USD)",
      counterparty_label: "From / To", counterparty: "Other wallet (short)", link: "Link (transaction or wallet)" },
    text:
`👛 <b>Wallet activity</b> · {net_emoji} {network}
${SEP}
📍 <b>Wallet:</b> {wallet_link}
{direction_icon} <b>{direction}:</b> {amount}
👤 <b>{counterparty_label}:</b> {counterparty}
${SEP}
🔎 {link}
${BRAND}`
  },
  contract_activity: {
    title: "Contract activity", group: "Personal alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", contract_link: "Contract (short, explorer link)", events: "Event names", count: "Number of events", tx_link: "Link to the transaction" },
    text:
`⌘ <b>Contract activity</b> · {net_emoji} {network}
${SEP}
📜 <b>Contract:</b> {contract_link}
🧩 <b>Events:</b> {events}
🔢 <b>Count:</b> {count}
${SEP}
🔎 {tx_link}
${BRAND}`
  }
});

/* ---------------------------------- sample data (admin preview) ---------------------------------- */
const COIN_SAMPLE = H("🚀 <b>BTC</b> · Bitcoin  <i>#1</i>\n💰 <b>$98,420.50</b>\n🕐 1h 🟢 <b>+0.42%</b>   🕓 4h 🟢 <b>+1.10%</b>\n🕗 8h 🔴 <b>−0.35%</b>   📆 24h 🟢 <b>+3.80%</b>");
const T0 = "2026-11-14 03:20 UTC";
const TX = "https://etherscan.io/tx/0x6ebc…";
export const SAMPLES = {
  tx: { network: "Ethereum", net_emoji: "🔷", status: "Success", status_icon: "✅", hash: "0x6ebc386e540856d46141ae26a0fbb14504d8c5109bf47640ee4d1eb81311522f", block: 26406878, time: "2026-11-13 15:16 UTC", method: "Contract interaction",
    from: "0x5b61…47d7", from_link: H('<a href="https://etherscan.io/address/0x5b61">0x5b61…47d7</a>'), to: "0xa0b8…eb48", to_link: H('<a href="https://etherscan.io/address/0xa0b8">0xa0b8…eb48</a>'),
    from_full: "0x5b61…", to_full: "0xa0b8…", amount: "0.5 ETH (~$1,500)", fee: "0.00312 ETH", updated: T0, explorer_link: TX },
  tx_notfound: { hash: "0x6ebc386e540856d46141ae26a0fbb14504d8c5109bf47640ee4d1eb81311522f", reason: "This transaction wasn't found on the enabled networks." },
  address_wallet: { network: "BNB Chain", net_emoji: "🟡", address: "0x1111111111111111111111111111111111111111", balance: "1.5 BNB (~$450.00)", stables: H("💵 <b>USDT:</b> 120"), notes: "", unavailable: "", risks: "",
    disclaimer: "This is information only — not a safety verdict, audit or investment advice.", source: "public RPC", updated: T0 },
  address_contract: { network: "Ethereum", net_emoji: "🔷", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", notes: H("ℹ️ Executable program"), unavailable: "", risks: "",
    disclaimer: "This is information only — not a safety verdict, audit or investment advice.", source: "public RPC", updated: T0 },
  address_token: { network: "Base", net_emoji: "🟦", name: "Test Token", symbol: "TST", address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", price: "$0.500", change24h: "(24h 🟢 +3.2%)", liquidity: "$5,000", volume24h: "$12,345",
    market_cap: "$1,000,000", supply: "1,000,000", market_missing: "", notes: "", unavailable: "", risks: H("⚠️ <b>Notes</b>\n• Low liquidity (under $10k)"),
    disclaimer: "This is information only — not a safety verdict, audit or investment advice.", source: "DEX Screener", updated: T0 },
  token_trade: { side: "BUY", side_icon: "🟢", network: "BNB Chain", net_emoji: "🟡", token_name: "Pepe Token", token_symbol: "PEPE", token_amount: "1,250,000", quote_amount: "0.85", quote_symbol: "WBNB",
    trader: "0x9a3f…c21d", contract: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", pair: "0x1b2c…77aa", tx_link: H('<a href="https://bscscan.com/tx/0x1">View transaction</a>') },
  price_update: { network: "Crypto", coins: COIN_SAMPLE, more: "", time: T0 },
  price_move: { network: "Crypto", coins: H(COIN_SAMPLE.html + "\n🔔 Since last alert: $97,100 → <b>$98,420.50</b> 🟢 <b>+1.36%</b>"), more: "", time: T0 },
  movers: { gainers: H("🟢 <b>AAA</b> $1.20\n   1h +2.1% · 4h +6.0% · 8h +9.3% · 24h <b>+18.40%</b>"), losers: H("🔴 <b>BBB</b> $0.40\n   1h −1.1% · 4h −4.0% · 8h −7.3% · 24h <b>−15.20%</b>"), time: T0 },
  trending: { coins: COIN_SAMPLE, more: "", time: T0 },
  new_token: { network: "Solana", net_emoji: "🟪", name: "Moon Cat", symbol: "MCAT", price: "$0.00042", liquidity: "$48.2K", fdv: "$420.0K", age: "12 min ago", link: H('<a href="https://dexscreener.com/solana/x">DEX Screener</a>') },
  new_token_footer: {},
  liquidity: { headline: "⚠️ Liquidity drop", token: "Moon Cat (MCAT) on Solana", detail: "$48.2K → $30.1K  (−37.5%)", link: H('<a href="https://dexscreener.com/solana/x">DEX Screener</a>'), time: T0 },
  whale: { network: "Ethereum", net_emoji: "🔷", amount: "$56,901,513 USDC", from: "0x5b61…47d7", to: "0xa0b8…eb48", tx_link: H('<a href="https://etherscan.io/tx/0x1">View transaction</a>') },
  wallet_move: { network: "Ethereum", net_emoji: "🔷", wallet_link: H('<a href="https://etherscan.io/address/0x1">0x5b61…47d7</a>'), direction: "Received", direction_icon: "⬇️", amount: "$2,500 USDT",
    counterparty_label: "From", counterparty: "0xa0b8…eb48", link: H('<a href="https://etherscan.io/tx/0x1">View transaction</a>') },
  contract_activity: { network: "BNB Chain", net_emoji: "🟡", contract_link: H('<a href="https://bscscan.com/address/0x1">0x1b2c…77aa</a>'), events: "Transfer · Approval", count: 3, tx_link: H('<a href="https://bscscan.com/tx/0x1">View transaction</a>') }
};

/* ---------------------------------- validation (admin save) ---------------------------------- */
const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "blockquote", "tg-spoiler"]);
export function validateTemplate(key, text) {
  const def = DEFAULT_TEMPLATES[key];
  if (!def) return { error: "UNKNOWN_TEMPLATE" };
  if (typeof text !== "string" || !text.trim()) return { error: "TEMPLATE_EMPTY" };
  if (text.length > 3000) return { error: "TEMPLATE_TOO_LONG" };
  const known = new Set(Object.keys(def.vars));
  const unknown = [...new Set([...text.matchAll(/\{(\w+)\??\}/g)].map(m => m[1]).filter(k => !known.has(k)))];
  if (unknown.length) return { error: "UNKNOWN_PLACEHOLDER", detail: unknown.map(x => "{" + x + "}").join(", ") };
  const stack = []; let rest = text;
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^<>]*)>/g)) {
    const [, close, name, attrs] = m, tag = name.toLowerCase();
    if (!TAGS.has(tag)) return { error: "TEMPLATE_BAD_HTML", detail: "tag <" + name + "> is not allowed" };
    if (close) { if (stack.pop() !== tag) return { error: "TEMPLATE_BAD_HTML", detail: "</" + name + "> does not match" }; continue; }
    if (tag === "a") { if (!/^\s+href="(https:\/\/[^"\s]+|tg:\/\/[^"\s]+)"\s*$/.test(attrs)) return { error: "TEMPLATE_BAD_HTML", detail: '<a> needs href="https://…"' }; }
    else if (tag === "pre" || tag === "code") { if (attrs.trim()) return { error: "TEMPLATE_BAD_HTML", detail: "<" + name + "> takes no attributes" }; }
    else if (attrs.trim()) return { error: "TEMPLATE_BAD_HTML", detail: "<" + name + "> takes no attributes" };
    stack.push(tag);
  }
  if (stack.length) return { error: "TEMPLATE_BAD_HTML", detail: "<" + stack[stack.length - 1] + "> is not closed" };
  rest = text.replace(/<\/?[a-zA-Z][\w-]*[^<>]*>/g, "");
  if (/[<>]/.test(rest)) return { error: "TEMPLATE_BAD_HTML", detail: "write < and > as &lt; and &gt;" };
  const preview = renderTemplate(text, SAMPLES[key] || {});
  if (!preview) return { error: "TEMPLATE_EMPTY" };
  return { value: text, preview };
}

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
