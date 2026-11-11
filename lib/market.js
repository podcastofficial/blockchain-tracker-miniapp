// Phase 4: market pulse (trending, gainers/losers, gas) and live whale feed. Public endpoints, cached.
import { EVM, rpc, j, fetchPrices } from "./balances.js";
import { send, methodNotAllowed } from "./http.js";

const store = new Map();
async function cached(key, ttl, fn) {
  const c = store.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); store.set(key, { t: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v; throw e; } // serve stale on upstream failure
}
const safeUrl = u => (typeof u === "string" && u.startsWith("https://") ? u : null);
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

async function trending() {
  const r = await j("https://api.coingecko.com/api/v3/search/trending");
  return (r.coins || []).slice(0, 10).map(({ item }) => ({
    id: item.id, symbol: item.symbol, name: item.name, rank: item.market_cap_rank ?? null,
    thumb: safeUrl(item.small || item.thumb), price: num(item.data?.price), change: num(item.data?.price_change_percentage_24h?.usd)
  }));
}

async function movers() {
  const r = await j("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h");
  const rows = r.filter(x => Number.isFinite(x.price_change_percentage_24h) && x.total_volume > 1e6 && x.current_price > 0)
    .map(x => ({ id: x.id, symbol: String(x.symbol).toUpperCase(), name: x.name, thumb: safeUrl(x.image), price: x.current_price, change: x.price_change_percentage_24h }));
  rows.sort((a, b) => b.change - a.change);
  return { gainers: rows.slice(0, 8), losers: rows.slice(-8).reverse() };
}

const GAS_NETS = ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche"];
async function gas() {
  const prices = await fetchPrices();
  return Promise.all(GAS_NETS.map(async n => {
    try {
      const gwei = Number(BigInt(await rpc(process.env["RPC_" + n.toUpperCase()] || EVM[n].rpc, "eth_gasPrice", []))) / 1e9;
      const px = prices[EVM[n].symbol]?.usd;
      return { network: n, gwei, transferUsd: px ? (gwei * 21000 / 1e9) * px : null };
    } catch { return { network: n, gwei: null, transferUsd: null }; }
  }));
}

export async function marketOverview(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const [t, m, g] = await Promise.allSettled([
    cached("trending", 120000, trending), cached("movers", 120000, movers), cached("gas", 30000, gas)]);
  res.setHeader("Cache-Control", "public, s-maxage=30");
  return send(res, 200, {
    ok: true,
    trending: t.status === "fulfilled" ? t.value : [],
    gainers: m.status === "fulfilled" ? m.value.gainers : [],
    losers: m.status === "fulfilled" ? m.value.losers : [],
    gas: g.status === "fulfilled" ? g.value : [],
    errors: [t, m, g].map((x, i) => x.status === "rejected" ? ["trending", "movers", "gas"][i] : null).filter(Boolean),
    updatedAt: new Date().toISOString()
  });
}

// ---- whale feed ----
const SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RANGE = { ethereum: 150, bsc: 600, polygon: 300 }; // blocks scanned per request (keeps public RPC responses small)
const EXPL = { ethereum: "https://etherscan.io/tx/", bsc: "https://bscscan.com/tx/", polygon: "https://polygonscan.com/tx/" };
const FLOOR = 50000, MINS = [50000, 100000, 250000, 500000, 1000000];
const sh = a => "0x" + a.slice(-40);

async function scanWhales(net) {
  const url = process.env["RPC_" + net.toUpperCase()] || EVM[net].rpc;
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  const from = latest - RANGE[net] + 1;
  const [bl, bf] = await Promise.all([rpc(url, "eth_getBlockByNumber", ["0x" + latest.toString(16), false]), rpc(url, "eth_getBlockByNumber", ["0x" + from.toString(16), false])]);
  const spb = Math.max(0.2, (parseInt(bl.timestamp, 16) - parseInt(bf.timestamp, 16)) / (latest - from));
  const out = [];
  for (const t of EVM[net].tokens) {
    const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16), address: t.address, topics: [SIG] }]);
    for (const l of logs) {
      if (l.topics.length !== 3) continue;
      const usd = Number(BigInt(l.data)) / 10 ** t.decimals;
      if (usd < FLOOR) continue;
      const block = parseInt(l.blockNumber, 16);
      out.push({ tx: l.transactionHash, block, symbol: t.symbol, usd, from: sh(l.topics[1]), to: sh(l.topics[2]),
        ageSec: Math.round((latest - block) * spb), link: EXPL[net] + l.transactionHash });
    }
  }
  out.sort((a, b) => b.block - a.block);
  return { events: out.slice(0, 200), windowSec: Math.round((latest - from) * spb) };
}

export async function whaleFeed(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const q = new URL(req.url, "https://x.invalid").searchParams;
  const net = String(q.get("network") || "ethereum").toLowerCase();
  const min = MINS.includes(Number(q.get("min"))) ? Number(q.get("min")) : 100000;
  if (!RANGE[net]) return send(res, 400, { ok: false, error: "UNSUPPORTED_NETWORK" });
  try {
    const d = await cached("whales:" + net, 60000, () => scanWhales(net));
    const events = d.events.filter(e => e.usd >= min).slice(0, 40);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return send(res, 200, { ok: true, network: net, min, windowSec: d.windowSec, events,
      totalUsd: events.reduce((a, e) => a + e.usd, 0), updatedAt: new Date().toISOString() });
  } catch { return send(res, 502, { ok: false, error: "RPC_BUSY" }); }
}
