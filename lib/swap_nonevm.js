// Token BUY / SELL alerts for Solana, Tron and (beta) TON, used by the existing on-chain alert worker (/api/cron/onchain).
// A rule is { kind: "contract", network: "solana"|"tron"|"ton", address: <token mint / TRC20 / jetton master> }.
// How it works (same idea as the EVM monitor): find the token's most liquid DEX pool on DexScreener, then read that pool's swaps.
//   Solana: Helius Enhanced Transactions (HELIUS_API_KEY)   Tron: TronGrid (TRONGRID_API_KEY optional)   TON: TONCenter v3 (beta)
import { j, fetchPrices } from "./balances.js";
import { H, NET_EMOJI, renderKey } from "./templates.js";
import { parseSolanaSwaps, parseTronPool, parseTonJettons } from "./swap_parsers.js";

export const SWAP_NETS = ["solana", "tron"];
export const tonEnabled = () => process.env.TON_SWAP_BETA === "1";
export const swapNets = () => (tonEnabled() ? [...SWAP_NETS, "ton"] : SWAP_NETS);

const NET_NAME = { solana: "Solana", tron: "Tron", ton: "TON" };
const TX_URL = { solana: "https://solscan.io/tx/", tron: "https://tronscan.org/#/transaction/", ton: "https://tonviewer.com/transaction/" };
const short = a => (a ? String(a).slice(0, 5) + "…" + String(a).slice(-4) : "?");
const fmt = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
const money = n => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 });
const clean = k => String(k || "").trim().replace(/^["']+|["']+$/g, "").trim();
const REDISCOVER_MS = 12 * 3600 * 1000, MAX_PER_SCAN = 10;

// Most liquid pool for the token (DexScreener chain ids: solana / tron / ton).
export async function discoverPool(network, token) {
  const pairs = await j(`https://api.dexscreener.com/token-pairs/v1/${network}/${encodeURIComponent(token)}`);
  const ok = (Array.isArray(pairs) ? pairs : []).filter(p => p.pairAddress && p.chainId === network
    && (p.baseToken?.address === token || p.quoteToken?.address === token) && Number(p.liquidity?.usd || 0) > 0);
  ok.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
  const p = ok[0]; if (!p) throw new Error("NO_LIQUIDITY_PAIR_FOUND");
  const t = p.baseToken?.address === token ? p.baseToken : p.quoteToken;
  return { pair: p.pairAddress, symbol: String(t?.symbol || "TOKEN").slice(0, 16), name: String(t?.name || t?.symbol || "Token").slice(0, 40),
    priceUsd: Number(p.priceUsd || 0), dex: p.dexId || "", discoveredAt: Date.now() };
}

async function fetchTrades(rule, state, prices) {
  const net = rule.network;
  if (net === "solana") {
    const key = clean(process.env.HELIUS_API_KEY);
    if (!key) throw new Error("HELIUS_NOT_CONFIGURED");
    const until = state.sig ? `&until=${encodeURIComponent(state.sig)}` : "";
    const txs = await j(`https://api.helius.xyz/v0/addresses/${state.pair}/transactions?api-key=${encodeURIComponent(key)}&type=SWAP&limit=100${until}`);
    const list = Array.isArray(txs) ? txs : [];
    if (list[0]?.signature) state.sig = list[0].signature;                       // newest first: next run only asks for newer ones
    return parseSolanaSwaps(list.filter(t => Number(t.timestamp) * 1000 >= state.startedAt), rule.address, prices.SOL?.usd || 0);
  }
  if (net === "tron") {
    const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
    const r = await j(`https://api.trongrid.io/v1/accounts/${state.pair}/transactions/trc20?only_confirmed=true&limit=200&order_by=block_timestamp,asc&min_timestamp=${state.ts + 1}`, { headers: h });
    for (const x of r.data || []) state.ts = Math.max(state.ts, Number(x.block_timestamp) || 0);
    return parseTronPool(r.data || [], { pool: state.pair, token: rule.address, trxUsd: prices.TRX?.usd || 0 });
  }
  // TON (beta)
  const h = process.env.TONCENTER_API_KEY ? { "X-API-Key": process.env.TONCENTER_API_KEY } : {};
  const q = new URLSearchParams({ owner_address: state.pair, jetton_master: rule.address, direction: "both", limit: "50", sort: "desc", start_utime: String(Math.floor(state.ts / 1000) + 1) });
  const r = await j(`https://toncenter.com/api/v3/jetton/transfers?${q}`, { headers: h });
  const rows = r.jetton_transfers || [];
  for (const x of rows) state.ts = Math.max(state.ts, (Number(x.transaction_now) || 0) * 1000);
  return parseTonJettons(rows, { pool: state.pair, priceUsd: state.priceUsd });
}

export function formatSwapEvent(rule, state, t, tpl = {}) {
  const buy = t.side === "BUY", url = (TX_URL[rule.network] || "") + t.txId, est = t.estimate ? " ~" : "";
  const tokenName = state.name || state.symbol || "Token", sym = state.symbol || "TOKEN";
  const summary = `${buy ? "🟢" : "🔴"} ${t.side} ${sym} on ${NET_NAME[rule.network] || rule.network}${t.estimate ? " (beta)" : ""}\n`
    + `${fmt(t.tokenAmount)} ${sym} for ${fmt(t.quoteAmount)} ${t.quoteSymbol}${t.usd > 0 ? ` (${est}${money(t.usd)})` : ""}\n`
    + `Trader ${short(t.trader)} · pool ${short(state.pair)}\n${url}`;
  let html;
  try {
    html = renderKey("token_trade", { side: t.side, side_icon: buy ? "🟢" : "🔴", network: (NET_NAME[rule.network] || rule.network) + (t.estimate ? " (beta)" : ""),
      net_emoji: NET_EMOJI[rule.network] || "🌐", token_name: tokenName, token_symbol: sym, token_amount: fmt(t.tokenAmount),
      quote_amount: fmt(t.quoteAmount), quote_symbol: t.quoteSymbol, trader: short(t.trader), contract: rule.address, pair: short(state.pair),
      tx_link: H(`<a href="${url}">View transaction</a>`) }, tpl);
  } catch { html = undefined; }
  return { key: t.key, usd: t.usd, summary, html };
}

// Called by onchain.js scanRule() for kind "contract" on a non-EVM network. Mutates state / events like the other scanners.
export async function swapScan(rule, state, events, tpl) {
  if (!swapNets().includes(rule.network)) throw new Error("NETWORK_NOT_ENABLED");
  const stale = !state.pair || Date.now() - (state.discoveredAt || 0) > REDISCOVER_MS;
  if (stale) {
    try { Object.assign(state, await discoverPool(rule.network, rule.address)); }
    catch (e) { if (!state.pair) throw e; }                                      // keep the old pool if rediscovery fails
  }
  if (!state.startedAt) { state.startedAt = Date.now(); state.ts = state.startedAt; return; }   // first run: start now, no historic spam
  const prices = await fetchPrices().catch(() => ({}));
  const { trades } = await fetchTrades(rule, state, prices);
  const all = rule.min_usd <= 0.01;                                              // UI sends 0.01 = "every trade"
  const found = trades.filter(t => all || t.usd >= rule.min_usd).sort((a, b) => b.usd - a.usd).slice(0, MAX_PER_SCAN);
  for (const t of found) events.push(formatSwapEvent(rule, state, t, tpl));
}
