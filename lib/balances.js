// Live balances (native + USDT/USDC) via public RPCs. No API key required.
// Override any RPC with env: RPC_ETHEREUM, RPC_BSC, RPC_POLYGON, RPC_ARBITRUM, RPC_BASE, RPC_OPTIMISM, RPC_AVALANCHE, RPC_SOLANA.
const T = (symbol, address, decimals) => ({ symbol, address, decimals });
export const EVM = {
  ethereum: { rpc: "https://ethereum-rpc.publicnode.com", symbol: "ETH", cg: "ethereum", tokens: [
    T("USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6), T("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6)] },
  bsc: { rpc: "https://bsc-dataseed.binance.org", symbol: "BNB", cg: "binancecoin", tokens: [
    T("USDT", "0x55d398326f99059fF775485246999027B3197955", 18), T("USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18)] },
  polygon: { rpc: "https://polygon-bor-rpc.publicnode.com", symbol: "POL", cg: "matic-network", tokens: [
    T("USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6), T("USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6)] },
  arbitrum: { rpc: "https://arb1.arbitrum.io/rpc", symbol: "ETH", cg: "ethereum", tokens: [
    T("USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6), T("USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6)] },
  base: { rpc: "https://mainnet.base.org", symbol: "ETH", cg: "ethereum", tokens: [
    T("USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6)] },
  optimism: { rpc: "https://mainnet.optimism.io", symbol: "ETH", cg: "ethereum", tokens: [
    T("USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6), T("USDC", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6)] },
  avalanche: { rpc: "https://api.avax.network/ext/bc/C/rpc", symbol: "AVAX", cg: "avalanche-2", tokens: [
    T("USDT", "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", 6), T("USDC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6)] }
};
const NATIVE_CG = { ETH: "ethereum", BNB: "binancecoin", POL: "matic-network", AVAX: "avalanche-2", TRX: "tron", SOL: "solana", TON: "the-open-network" };
export const SUPPORTED = [...Object.keys(EVM), "tron", "solana", "ton"];

export function validAddr(net, a) {
  if (EVM[net]) return /^0x[a-fA-F0-9]{40}$/.test(a);
  if (net === "tron") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (net === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (net === "ton") return /^(0:[a-fA-F0-9]{64}|EQ[A-Za-z0-9_-]{46,50}|UQ[A-Za-z0-9_-]{46,50})$/.test(a);
  return false;
}

async function j(url, opts = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    if (!r.ok) throw new Error("UPSTREAM_" + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const rpc = async (url, method, params) => {
  const r = await j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (r.error) throw new Error("RPC_ERROR");
  return r.result;
};
const units = (big, dec) => Number(big) / 10 ** dec;

async function evmBalance(net, addr) {
  const c = EVM[net]; const url = process.env["RPC_" + net.toUpperCase()] || c.rpc;
  const pad = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const [nat, ...tok] = await Promise.all([
    rpc(url, "eth_getBalance", [addr, "latest"]),
    ...c.tokens.map(t => rpc(url, "eth_call", [{ to: t.address, data: "0x70a08231" + pad }, "latest"]).catch(() => "0x0"))
  ]);
  return { symbol: c.symbol, native: units(BigInt(nat), 18), tokens: c.tokens.map((t, i) => ({ symbol: t.symbol, amount: units(BigInt(tok[i] || "0x0"), t.decimals) })) };
}

async function tronBalance(addr) {
  const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const r = await j("https://api.trongrid.io/v1/accounts/" + addr, { headers: h });
  const acc = r.data?.[0]; if (!acc) return { symbol: "TRX", native: 0, tokens: [] };
  const m = Object.assign({}, ...(acc.trc20 || []));
  return { symbol: "TRX", native: (acc.balance || 0) / 1e6, tokens: [
    { symbol: "USDT", amount: Number(m["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] || 0) / 1e6 },
    { symbol: "USDC", amount: Number(m["TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8"] || 0) / 1e6 }] };
}

async function solBalance(addr) {
  const url = process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com";
  const mints = { USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
  const [bal, ...tk] = await Promise.all([
    rpc(url, "getBalance", [addr]),
    ...Object.values(mints).map(mint => rpc(url, "getTokenAccountsByOwner", [addr, { mint }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })))
  ]);
  return { symbol: "SOL", native: bal.value / 1e9, tokens: Object.keys(mints).map((s, i) => ({
    symbol: s, amount: (tk[i].value || []).reduce((a, x) => a + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0) })) };
}

async function tonBalance(addr) {
  const h = process.env.TONCENTER_API_KEY ? { "X-API-Key": process.env.TONCENTER_API_KEY } : {};
  const r = await j("https://toncenter.com/api/v2/getAddressBalance?address=" + encodeURIComponent(addr), { headers: h });
  return { symbol: "TON", native: Number(r.result || 0) / 1e9, tokens: [] };
}

export function fetchBalance(net, addr) {
  if (EVM[net]) return evmBalance(net, addr);
  if (net === "tron") return tronBalance(addr);
  if (net === "solana") return solBalance(addr);
  return tonBalance(addr);
}

let priceCache = { t: 0, data: {} };
export async function fetchPrices() {
  if (Date.now() - priceCache.t < 60000) return priceCache.data;
  try {
    const ids = Object.values(NATIVE_CG).join(",");
    const r = await j(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    const out = {};
    for (const [sym, id] of Object.entries(NATIVE_CG)) if (r[id]) out[sym] = { usd: r[id].usd, change: r[id].usd_24h_change || 0 };
    priceCache = { t: Date.now(), data: out };
  } catch { /* keep stale cache */ }
  return priceCache.data;
}
