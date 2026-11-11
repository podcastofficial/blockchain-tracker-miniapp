// On-chain scanners for wallet-activity and whale-transfer rules (public RPC / TronGrid, no paid key).
import { EVM, fetchBalance, fetchPrices, rpc, j } from "./balances.js";

const SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const WHALE_NETS = ["ethereum", "bsc", "polygon"];
const EXPL = {
  ethereum: "https://etherscan.io", bsc: "https://bscscan.com", polygon: "https://polygonscan.com",
  arbitrum: "https://arbiscan.io", base: "https://basescan.org", optimism: "https://optimistic.etherscan.io",
  avalanche: "https://snowtrace.io", tron: "https://tronscan.org/#", solana: "https://solscan.io", ton: "https://tonviewer.com"
};
const rpcUrl = n => process.env["RPC_" + n.toUpperCase()] || EVM[n].rpc;
const pad = a => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "?";
const money = n => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 });
const txLink = (net, h) => net === "tron" ? `${EXPL.tron}/transaction/${h}` : net === "solana" ? `${EXPL.solana}/tx/${h}` : EXPL[net] ? `${EXPL[net]}/tx/${h}` : "";
const addrLink = (net, a) => net === "tron" ? `${EXPL.tron}/address/${a}` : net === "solana" ? `${EXPL.solana}/account/${a}` : net === "ton" ? `${EXPL.ton}/${a}` : `${EXPL[net]}/address/${a}`;

async function nativeDelta(rule, state, events, prices) {
  const b = await fetchBalance(rule.network, rule.address);
  const prev = state.native;
  state.native = b.native;
  if (typeof prev !== "number") return;
  const diff = b.native - prev;
  const usd = Math.abs(diff) * (prices[b.symbol]?.usd || 0);
  if (usd >= rule.min_usd && usd > 0) {
    events.push({ key: `native:${Date.now()}`, usd,
      summary: `👛 ${short(rule.address)} on ${rule.network}\n${diff > 0 ? "⬇️ Received" : "⬆️ Sent"} ≈ ${Math.abs(diff).toFixed(4)} ${b.symbol} (${money(usd)})\n${addrLink(rule.network, rule.address)}` });
  }
}

async function evmWallet(rule, state, events) {
  const c = EVM[rule.network], url = rpcUrl(rule.network);
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  if (!state.block) { state.block = latest; return; }
  const from = state.block + 1, to = Math.min(latest, from + 1999);
  if (from > latest) return;
  const me = pad(rule.address);
  for (const t of c.tokens) {
    const [inc, out] = await Promise.all([
      rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: t.address, topics: [SIG, null, me] }]),
      rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: t.address, topics: [SIG, me] }])
    ]);
    for (const [logs, dir] of [[inc, "in"], [out, "out"]]) for (const l of logs) {
      const usd = Number(BigInt(l.data)) / 10 ** t.decimals;
      if (usd < rule.min_usd) continue;
      const cp = "0x" + (dir === "in" ? l.topics[1] : l.topics[2]).slice(-40);
      events.push({ key: `${l.transactionHash}:${l.logIndex}`, usd,
        summary: `👛 ${short(rule.address)} on ${rule.network}\n${dir === "in" ? "⬇️ Received" : "⬆️ Sent"} ${money(usd)} ${t.symbol} ${dir === "in" ? "from" : "to"} ${short(cp)}\n${txLink(rule.network, l.transactionHash)}` });
    }
  }
  state.block = to;
}

async function tronWallet(rule, state, events) {
  const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  if (!state.ts) { state.ts = Date.now(); return; }
  const r = await j(`https://api.trongrid.io/v1/accounts/${rule.address}/transactions/trc20?only_confirmed=true&limit=50&order_by=block_timestamp,asc&min_timestamp=${state.ts + 1}`, { headers: h });
  for (const x of r.data || []) {
    state.ts = Math.max(state.ts, x.block_timestamp);
    const sym = x.token_info?.symbol;
    if (!["USDT", "USDC"].includes(sym)) continue;
    const usd = Number(x.value) / 10 ** Number(x.token_info.decimals || 6);
    if (usd < rule.min_usd) continue;
    const dir = x.to === rule.address ? "in" : "out";
    events.push({ key: x.transaction_id, usd,
      summary: `👛 ${short(rule.address)} on tron\n${dir === "in" ? "⬇️ Received" : "⬆️ Sent"} ${money(usd)} ${sym} ${dir === "in" ? "from" : "to"} ${short(dir === "in" ? x.from : x.to)}\n${txLink("tron", x.transaction_id)}` });
  }
}

const PRIV = {
  "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0": "👑 Ownership transferred",
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b": "🔁 Proxy implementation upgraded",
  "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f": "🛡 Proxy admin changed",
  "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258": "⏸ Contract paused",
  "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa": "▶️ Contract unpaused",
  "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d": "🔑 Role granted",
  "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b": "🚫 Role revoked"
};
// Privileged-action monitor for a watched EVM contract (ownership, upgrades, pause, roles).
async function contractWatch(rule, state, events) {
  const url = rpcUrl(rule.network);
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  if (!state.block) { state.block = latest; return; }
  const from = state.block + 1, to = Math.min(latest, from + 1999);
  if (from > latest) return;
  const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: rule.address, topics: [Object.keys(PRIV)] }]);
  for (const l of logs.slice(0, 10)) {
    events.push({ key: `${l.transactionHash}:${l.logIndex}`, usd: 0,
      summary: `🛠 ${PRIV[l.topics[0]]}\nContract ${short(rule.address)} on ${rule.network}\n${txLink(rule.network, l.transactionHash)}` });
  }
  state.block = to;
}

async function whale(rule, state, events) {
  const c = EVM[rule.network], url = rpcUrl(rule.network);
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  if (!state.block || latest - state.block > 3000) { state.block = latest - (state.block ? 400 : 0); if (!state.block || state.block === latest) return; }
  const from = state.block + 1, to = Math.min(latest, from + 399);
  if (from > latest) return;
  const found = [];
  for (const t of c.tokens) {
    const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: t.address, topics: [SIG] }]);
    for (const l of logs) {
      if (l.topics.length !== 3) continue;
      const usd = Number(BigInt(l.data)) / 10 ** t.decimals;
      if (usd >= rule.min_usd) found.push({ key: `${l.transactionHash}:${l.logIndex}`, usd,
        summary: `🐋 Whale transfer on ${rule.network}\n${money(usd)} ${t.symbol}\n${short("0x" + l.topics[1].slice(-40))} → ${short("0x" + l.topics[2].slice(-40))}\n${txLink(rule.network, l.transactionHash)}` });
    }
  }
  found.sort((a, b) => b.usd - a.usd);
  events.push(...found.slice(0, 5)); // cap spam per run
  state.block = to;
}

export async function scanRule(rule) {
  const state = { ...(rule.state || {}) }, events = [];
  if (rule.kind === "whale") await whale(rule, state, events);
  else if (rule.kind === "contract") await contractWatch(rule, state, events);
  else {
    if (EVM[rule.network]) await evmWallet(rule, state, events);
    else if (rule.network === "tron") await tronWallet(rule, state, events);
    await nativeDelta(rule, state, events, await fetchPrices());
  }
  return { state, events };
}
