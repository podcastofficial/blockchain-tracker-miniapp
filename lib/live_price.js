// Live USD prices for tokens a wallet still holds, so unrealized PnL is not stuck on the last trade price.
// Source: DexScreener (public, no key). A price is used only when the pair has real liquidity; otherwise the engine keeps its
// last-trade price and labels it as such (never a guessed number).
import { computePnl } from "./pnl_engine.js";

const DS_CHAIN = { ethereum: "ethereum", bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", base: "base", optimism: "optimism", avalanche: "avalanche", solana: "solana", tron: "tron", ton: "ton" };
const MIN_LIQ_USD = Number(process.env.LIVE_PRICE_MIN_LIQ_USD || 2000);
const cache = new Map();   // key -> { t, px }
const TTL = 60000;

async function getJson(url, ms) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("UPSTREAM_" + r.status);
  return r.json();
}

// keys: ["ethereum:0xabc…", "solana:Mint…"] -> { key: usdPrice }. Missing keys simply have no live price.
export async function livePrices(keys, { timeoutMs = 4500 } = {}) {
  const out = {}, need = [];
  for (const k of new Set(keys)) {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.t < TTL) { if (hit.px > 0) out[k] = hit.px; } else need.push(k);
  }
  if (!need.length) return out;
  const t0 = Date.now();
  const byChain = new Map();
  for (const k of need) {
    const i = k.indexOf(":"), net = k.slice(0, i), addr = k.slice(i + 1);
    if (!DS_CHAIN[net] || !addr || addr === "native") continue;
    (byChain.get(net) || byChain.set(net, []).get(net)).push(addr);
  }
  const jobs = [];
  for (const [net, addrs] of byChain) {
    for (let i = 0; i < addrs.length; i += 30) {
      const part = addrs.slice(i, i + 30);
      jobs.push((async () => {
        try {
          const left = Math.max(800, timeoutMs - (Date.now() - t0));
          const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${part.map(encodeURIComponent).join(",")}`, left);
          const best = new Map();
          for (const p of d.pairs || []) {
            if (String(p.chainId).toLowerCase() !== DS_CHAIN[net]) continue;
            const a = String(p.baseToken?.address || ""), px = Number(p.priceUsd), liq = Number(p.liquidity?.usd) || 0;
            if (!(px > 0) || liq < MIN_LIQ_USD) continue;
            const key = `${net}:${net === "solana" || net === "tron" || net === "ton" ? a : a.toLowerCase()}`;
            const cur = best.get(key);
            if (!cur || liq > cur.liq) best.set(key, { px, liq });
          }
          for (const k of need) { const b = best.get(k); if (b) { out[k] = b.px; cache.set(k, { t: Date.now(), px: b.px }); } }
        } catch { /* leave those tokens on last-trade price */ }
      })());
    }
  }
  await Promise.all(jobs);
  for (const k of need) if (!cache.has(k) || Date.now() - cache.get(k).t >= TTL) cache.set(k, { t: Date.now(), px: 0 });   // negative cache: don't hammer the API
  return out;
}

// Same output as computePnl(), but open positions are marked at live prices when available.
export async function computePnlLive(trades, opts = {}) {
  const marks = { ...(opts.marks || {}) };
  const first = computePnl(trades, { ...opts, marks });
  const open = first.byToken.filter(t => t.holding > 1e-12 && t.markSource !== "live").map(t => t.key).filter(k => !k.endsWith(":native"));
  if (!open.length) return first;
  const live = await livePrices(open.slice(0, 60), { timeoutMs: opts.timeoutMs || 4500 }).catch(() => ({}));
  if (!Object.keys(live).length) return first;
  return computePnl(trades, { ...opts, marks: { ...marks, ...live } });
}
