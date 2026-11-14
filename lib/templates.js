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
`🧾 <b>TRANSACTION REPORT</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
{status_icon} <b>Status:</b> {status}
⚙️ <b>Type:</b> {method}
${SEP}
🔖 <b>Hash:</b> <code>{hash}</code>
📦 <b>Block:</b> {block}
🕒 <b>Block time:</b> {time}
${SEP}
📤 <b>From:</b> {from_link}
📥 <b>To:</b> {to_link}
💰 <b>Amount:</b> {amount}
⛽ <b>Network fee:</b> {fee}
${SEP}
🔄 <i>Last updated: {updated}</i>
${BRAND}`
  },
  tx_notfound: {
    title: "Transaction not found", group: "Community · /track",
    vars: { hash: "Transaction hash", reason: "Why it was not found" },
    text:
`🧾 <b>TRANSACTION LOOKUP</b>
${SEP}
🔖 <b>Hash:</b> <code>{hash}</code>
❌ <b>Result:</b> Not found
⚠️ <b>Reason:</b> {reason}
${SEP}
💡 <i>Check the hash and the network. A transaction that was just sent can take a few minutes to appear.</i>
${BRAND}`
  },
  address_wallet: {
    title: "Wallet detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", address: "Full address", balance: "Native balance with USD", stables: "Stablecoin balances (multi line)",
      notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`👛 <b>WALLET DETECTED</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
🧩 <b>Type:</b> Wallet (externally owned address)
📍 <b>Address:</b>
<code>{address}</code>
${SEP}
💎 <b>Native balance:</b> {balance}
{stables}
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Last updated: {updated}</i>
${BRAND}`
  },
  address_contract: {
    title: "Contract detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", address: "Full address", notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`📜 <b>CONTRACT DETECTED</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
🧩 <b>Type:</b> Smart contract / program
🔍 <b>Verification:</b> Not checked
📍 <b>Address:</b>
<code>{address}</code>
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Last updated: {updated}</i>
${BRAND}`
  },
  address_token: {
    title: "Token detected", group: "Community · /track",
    vars: { network: "Network name", net_emoji: "Network emoji", name: "Token name", symbol: "Token symbol", address: "Full address", price: "Price (USD)", change24h: "24h change",
      liquidity: "Liquidity (USD)", volume24h: "24h volume (USD)", market_cap: "Market cap / FDV", supply: "Supply", market_missing: "Shown only if no market data",
      notes: "Info notes", unavailable: "Data that could not be loaded", risks: "Fact notes block", disclaimer: "Not-advice line", source: "Data sources", updated: "Update time (UTC)" },
    text:
`🪙 <b>TOKEN DETECTED</b>
${SEP}
🏷 <b>Name:</b> {name} ({symbol?})
{net_emoji} <b>Network:</b> {network}
📍 <b>Contract:</b> <code>{address}</code>
${SEP}
💲 <b>Price:</b> {price} {change24h?}
💧 <b>Liquidity:</b> {liquidity}
📊 <b>24h volume:</b> {volume24h}
🏦 <b>Market cap / FDV:</b> {market_cap}
📦 <b>Supply:</b> {supply}
⚠️ {market_missing}
${SEP}
{notes}
{unavailable}
{risks}
🛡 <i>{disclaimer}</i>
📡 <i>Source: {source}</i>
🔄 <i>Last updated: {updated}</i>
${BRAND}`
  },
  token_trade: {
    title: "Token BUY / SELL alert", group: "Community · /watchcontract",
    vars: { side: "BUY or SELL", side_icon: "🟢 or 🔴", network: "Network name", net_emoji: "Network emoji", token_name: "Token name", token_symbol: "Token symbol",
      token_amount: "Token amount", quote_amount: "Quote amount", quote_symbol: "Quote symbol", trader: "Trader (short)", contract: "Token contract (full)", pair: "Pair (short)", tx_link: "Link to the transaction" },
    text:
`{side_icon} <b>TOKEN {side} ALERT</b>
${SEP}
🪙 <b>Token:</b> {token_name} ({token_symbol})
{net_emoji} <b>Network:</b> {network}
${SEP}
📦 <b>Token amount:</b> {token_amount}
💱 <b>Paid / received:</b> {quote_amount} {quote_symbol}
👤 <b>Trader:</b> <code>{trader}</code>
${SEP}
📜 <b>Contract:</b> <code>{contract}</code>
🔁 <b>Pair:</b> <code>{pair}</code>
${SEP}
🔎 {tx_link}
ℹ️ <i>On-chain DEX swap event · USD value not supplied by this RPC parser</i>
${BRAND}`
  }
};

Object.assign(DEFAULT_TEMPLATES, {
  price_alert: {
    title: "Price target reached (personal alert)", group: "Personal alerts",
    vars: { symbol: "Coin symbol", direction: "above / below", direction_icon: "📈 or 📉", target: "Your target price", price: "Price now", diff: "How far past the target (%)", time: "Trigger time (UTC)" },
    text:
`🎯 <b>PRICE ALERT TRIGGERED</b>
${SEP}
🪙 <b>Coin:</b> {symbol}
{direction_icon} <b>Status:</b> Price went <b>{direction}</b> your target
${SEP}
🎯 <b>Your target:</b> {target}
💰 <b>Price now:</b> <b>{price}</b>
📏 <b>Beyond target:</b> {diff}
🕒 <b>Triggered:</b> {time}
${SEP}
✅ <i>This alert is completed. Set a new one in the Mini App to keep tracking.</i>
${BRAND}`
  },
  price_update: {
    title: "Price update (scheduled)", group: "Channel alerts",
    vars: { network: "Blockchain / Crypto", coins: "Coin cards (price, rank, market cap, volume, 1h/4h/8h/24h/7d)", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`📈 <b>{network} PRICE UPDATE</b>
🔔 Scheduled market snapshot
${SEP}
{coins}
${SEP}
{more}
🕒 <b>Time:</b> {time}
📡 <i>Data: CoinGecko · 4h and 8h changes are close estimates</i>
${BRAND}`
  },
  price_move: {
    title: "Price move (only on change)", group: "Channel alerts",
    vars: { network: "Blockchain / Crypto", coins: "Coin cards incl. “since last alert”", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`🚨 <b>{network} PRICE MOVE ALERT</b>
⚡ Big price change detected
${SEP}
{coins}
${SEP}
{more}
🕒 <b>Time:</b> {time}
📡 <i>Data: CoinGecko · change is measured since the last alert</i>
${BRAND}`
  },
  movers: {
    title: "Top gainers & losers", group: "Channel alerts",
    vars: { gainers: "Gainer lines", losers: "Loser lines", time: "Post time (UTC)" },
    text:
`🏆 <b>TOP GAINERS &amp; LOSERS</b>
📊 Biggest movers in the last 24 hours
${SEP}
🚀 <b>TOP GAINERS</b>
{gainers}
${SEP}
💥 <b>TOP LOSERS</b>
{losers}
${SEP}
🕒 <b>Time:</b> {time}
📡 <i>Data: CoinGecko</i>
${BRAND}`
  },
  trending: {
    title: "Trending coins", group: "Channel alerts",
    vars: { coins: "Coin cards", more: "“…and N more” when the list is cut", time: "Post time (UTC)" },
    text:
`🔥 <b>TRENDING COINS</b>
👀 What the market is searching for right now
${SEP}
{coins}
${SEP}
{more}
🕒 <b>Time:</b> {time}
📡 <i>Data: CoinGecko</i>
${BRAND}`
  },
  new_token: {
    title: "New token (one block per token)", group: "Channel alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", name: "Token name", symbol: "Token symbol", address: "Token contract (full)", dex: "DEX name", price: "Price (USD)", change24h: "24h price change",
      liquidity: "Liquidity (USD)", volume24h: "24h volume (USD)", fdv: "FDV (USD)", txns: "24h buys / sells", age: "Pair age", link: "DEX Screener link" },
    text:
`🆕 <b>NEW TOKEN DETECTED</b>
${SEP}
🏷 <b>Name:</b> {name} ({symbol?})
{net_emoji} <b>Network:</b> {network}
🏪 <b>DEX:</b> {dex}
📍 <b>Contract:</b> <code>{address}</code>
${SEP}
💰 <b>Price:</b> {price}
📈 <b>24h change:</b> {change24h}
💧 <b>Liquidity:</b> {liquidity}
📊 <b>24h volume:</b> {volume24h}
🏦 <b>FDV:</b> {fdv}
🔁 <b>24h trades:</b> {txns}
⏱ <b>Pair created:</b> {age}
${SEP}
🔗 {link}`
  },
  new_token_footer: {
    title: "New token (footer, once per post)", group: "Channel alerts",
    vars: {},
    text:
`${SEP}
⚠️ <b>RISK WARNING</b>
• New tokens are very high risk (rug pulls, honeypots, thin liquidity)
• Check the contract, liquidity lock and holders before buying
• Information only, not financial advice. Always do your own research.
${BRAND}`
  },
  liquidity: {
    title: "Liquidity alert (drop / added / low)", group: "Channel alerts",
    vars: { headline: "🚨 LIQUIDITY REMOVED / ⚠️ Liquidity drop / 💧 added / 🔻 low", token: "Token + network", detail: "Before → after (change) or limit (one line)", net_emoji: "Network emoji", network: "Network name", address: "Token contract (full)",
      before: "Liquidity before", after: "Liquidity now", change: "Change in % (with 🟢 / 🔴)", limit: "Your minimum limit (low-liquidity alert only)", price: "Price (USD)", volume24h: "24h volume (USD)", note: "Short explanation for this alert type", link: "DEX Screener link", time: "Post time (UTC)" },
    text:
`{headline}
${SEP}
🪙 <b>Token:</b> {token}
{net_emoji} <b>Network:</b> {network}
📍 <b>Contract:</b> <code>{address}</code>
${SEP}
💧 <b>Liquidity before:</b> {before}
💧 <b>Liquidity now:</b> {after}
📊 <b>Change:</b> {change}
🔻 <b>Your limit:</b> {limit}
💲 <b>Price:</b> {price}
📈 <b>24h volume:</b> {volume24h}
${SEP}
{note}
🔗 {link}
🕒 <b>Time:</b> {time}
${BRAND}`
  },
  whale: {
    title: "Whale transfer", group: "Channel & personal alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", amount: "Amount + token", usd: "Value in USD", token: "Token symbol", block: "Block number", from: "Sender (short)", to: "Receiver (short)", tx_link: "Link to the transaction" },
    text:
`🐋 <b>WHALE TRANSFER ALERT</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
💰 <b>Amount:</b> {amount}
💵 <b>Value:</b> {usd}
📦 <b>Block:</b> {block}
${SEP}
📤 <b>From:</b> <code>{from}</code>
📥 <b>To:</b> <code>{to}</code>
${SEP}
🔎 {tx_link}
⚠️ <i>Large transfers can move the market. Watch for exchange deposits.</i>
${BRAND}`
  },
  wallet_move: {
    title: "Wallet activity (received / sent)", group: "Personal alerts",
    vars: { network: "Network name", net_emoji: "Network emoji", wallet_link: "Your wallet (short, explorer link)", direction: "Received / Sent", direction_icon: "⬇️ or ⬆️", amount: "Amount (+ USD)",
      counterparty_label: "From / To", counterparty: "Other wallet (short)", link: "Link (transaction or wallet)" },
    text:
`👛 <b>WALLET ACTIVITY ALERT</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
📍 <b>Your wallet:</b> {wallet_link}
${SEP}
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
`📜 <b>CONTRACT ACTIVITY ALERT</b>
${SEP}
{net_emoji} <b>Network:</b> {network}
📍 <b>Contract:</b> {contract_link}
${SEP}
🧩 <b>Events:</b> {events}
🔢 <b>Event count:</b> {count}
${SEP}
🔎 {tx_link}
${BRAND}`
  }
});

/* ---------------------------------- sample data (admin preview) ---------------------------------- */
const COIN_SAMPLE = H("🚀 <b>BTC</b> · Bitcoin  <i>#1</i>\n💰 <b>$98,420.50</b>\n🕐 1h 🟢 <b>+0.42%</b>   🕓 4h 🟢 <b>+1.10%</b>\n🕗 8h 🔴 <b>−0.35%</b>   📆 24h 🟢 <b>+3.80%</b>\n🗓 7d 🟢 <b>+9.20%</b>\n🏦 MCap <b>$1.95T</b>   📊 Vol <b>$48.20B</b>");
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
  price_alert: { symbol: "BTC", direction: "above", direction_icon: "📈", target: "$98,000", price: "$98,420.50", diff: "🟢 +0.43%", time: T0 },
  price_update: { network: "Crypto", coins: COIN_SAMPLE, more: "", time: T0 },
  price_move: { network: "Crypto", coins: H(COIN_SAMPLE.html + "\n🔔 Since last alert: $97,100 → <b>$98,420.50</b> 🟢 <b>+1.36%</b>"), more: "", time: T0 },
  movers: { gainers: H("🟢 <b>AAA</b> · Alpha Coin <i>#42</i>\n💰 <b>$1.20</b>\n   🕐 1h +2.1% · 🕓 4h +6.0% · 🕗 8h +9.3% · 📆 24h <b>+18.40%</b>\n   🏦 MCap $120.5M · 📊 Vol $14.2M"), losers: H("🔴 <b>BBB</b> · Beta Coin <i>#77</i>\n💰 <b>$0.40</b>\n   🕐 1h −1.1% · 🕓 4h −4.0% · 🕗 8h −7.3% · 📆 24h <b>−15.20%</b>\n   🏦 MCap $64.0M · 📊 Vol $5.1M"), time: T0 },
  trending: { coins: COIN_SAMPLE, more: "", time: T0 },
  new_token: { network: "Solana", net_emoji: "🟪", name: "Moon Cat", symbol: "MCAT", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", dex: "Raydium", price: "$0.00042", change24h: "🟢 +12.4%", liquidity: "$48.2K", volume24h: "$91.5K", fdv: "$420.0K", txns: "310 buys / 188 sells", age: "12 min ago", link: H('<a href="https://dexscreener.com/solana/x">DEX Screener</a>') },
  new_token_footer: {},
  liquidity: { headline: "⚠️ LIQUIDITY DROP", token: "Moon Cat (MCAT)", detail: "$48.2K → $30.1K  (−37.5%)", net_emoji: "🟪", network: "Solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", before: "$48.2K", after: "$30.1K", change: "🔴 −37.5%", limit: "", price: "$0.00042", volume24h: "$91.5K",
    note: "⚠️ Liquidity dropped sharply. Expect higher slippage and higher risk.", link: H('<a href="https://dexscreener.com/solana/x">DEX Screener</a>'), time: T0 },
  whale: { network: "Ethereum", net_emoji: "🔷", amount: "$56,901,513 USDC", usd: "$56,901,513", token: "USDC", block: 26406878, from: "0x5b61…47d7", to: "0xa0b8…eb48", tx_link: H('<a href="https://etherscan.io/tx/0x1">View transaction</a>') },
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
