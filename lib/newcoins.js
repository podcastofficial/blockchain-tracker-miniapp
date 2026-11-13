// New-coin discovery feed for the Launchpad "Explore" tab.
//   GET /api/launch/feed?source=all|pumpfun|pancakeswap|solana|dexscreener|coingecko
// Sources (all public, no key needed, every upstream call is cached and falls back to the last good copy):
//   DexScreener  -> newest token profiles (lib/dex.js)
//   CoinGecko    -> /coins/list/new (needs an eligible plan) -> falls back to GeckoTerminal new pools (CoinGecko's on-chain API)
//   Pump.fun     -> pump.fun frontend API -> falls back to GeckoTerminal / DexScreener pump.fun pools
//   PancakeSwap  -> GeckoTerminal BSC new pools + DexScreener BSC pairs, filtered to PancakeSwap
//   Solana       -> GeckoTerminal Solana new pools + DexScreener Solana pairs
import { send, methodNotAllowed } from "./http.js";
import { rateLimited, clientKey } from "./ratelimit.js";
import { newItems } from "./dex.js";
import { recentlyAddedCoins } from "./market.js";

const GT = "https://api.geckoterminal.com/api/v2";
const TTL = 60000;
const SOURCES = ["pumpfun", "pancakeswap", "solana", "dexscreener", "coingecko"];   // order = label priority in "all"

const store = new Map();
async function cached(key, ttl, fn) {
  const c = store.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); store.set(key, { t: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v; throw e; }          // upstream down: serve the last good copy
}
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error("UPSTREAM_" + r.status);
  return r.json();
}
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const https = u => (typeof u === "string" && /^https:\/\//i.test(u) && u.length < 500 && !/missing/i.test(u) ? u : null);
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

const item = (src, o) => ({
  src, chain: str(o.chain, 20), dex: str(o.dex, 40), name: str(o.name, 60), symbol: str(o.symbol, 20),
  address: str(o.address, 90), pair: str(o.pair, 90), priceUsd: num(o.priceUsd), liquidity: num(o.liquidity),
  marketCap: num(o.marketCap), volume24: num(o.volume24), change24: num(o.change24), created: num(o.created),
  image: https(o.image), url: https(o.url)
});

/* ---------------------------------- upstreams ---------------------------------- */
const fromDex = it => ({
  chain: it.chain, dex: it.dex, name: it.base.name, symbol: it.base.symbol, address: it.base.address, pair: it.pair,
  priceUsd: it.priceUsd, liquidity: it.liquidity, marketCap: it.marketCap ?? it.fdv, volume24: it.volume.h24,
  change24: it.change.h24, created: it.created, image: it.image, url: it.url
});
const dexRows = () => cached("feed:dex", TTL, async () => (await newItems("profiles")).map(fromDex));

// GeckoTerminal new pools of one network (page 1 = newest 20 pools)
const geckoNew = (network, page = 1) => cached(`feed:gt:${network}:${page}`, TTL, async () => {
  const d = await getJson(`${GT}/networks/${network}/new_pools?include=base_token,dex&page=${page}`, { Accept: "application/json;version=20230302" });
  const tok = new Map();
  for (const i of d.included || []) if (i.type === "token") tok.set(i.id, i.attributes || {});
  return (d.data || []).map(p => {
    const a = p.attributes || {}, r = p.relationships || {};
    const tid = r.base_token?.data?.id || "", t = tok.get(tid) || {};
    return {
      chain: network, dex: r.dex?.data?.id || "", name: t.name || String(a.name || "").split(" / ")[0],
      symbol: t.symbol || String(a.name || "").split(" / ")[0], address: t.address || tid.split("_").slice(1).join("_"),
      pair: a.address, priceUsd: a.base_token_price_usd, liquidity: a.reserve_in_usd, marketCap: a.market_cap_usd ?? a.fdv_usd,
      volume24: a.volume_usd?.h24, change24: a.price_change_percentage?.h24, created: Date.parse(a.pool_created_at) || null,
      image: t.image_url, url: `https://www.geckoterminal.com/${network}/pools/${a.address}`
    };
  });
});

const dexUrl = r => (r.chain && r.pair ? `https://dexscreener.com/${encodeURIComponent(r.chain)}/${encodeURIComponent(r.pair)}` : null);
const newest = rows => rows.sort((a, b) => (b.created || 0) - (a.created || 0));
const dedupe = rows => { const s = new Set(); return rows.filter(r => { const k = r.chain + ":" + r.address.toLowerCase(); if (!r.address || s.has(k)) return false; s.add(k); return true; }); };

/* ---------------------------------- per-source loaders ---------------------------------- */
const loaders = {
  async dexscreener() {
    return newest(await dexRows()).map(r => item("dexscreener", { ...r, url: r.url || dexUrl(r) }));
  },

  async coingecko() {
    try {
      const coins = await recentlyAddedCoins();                       // CoinGecko /coins/list/new (plan dependent)
      if (coins.length) return coins.map(c => item("coingecko", { chain: "coingecko", name: c.name, symbol: c.symbol, address: c.id,
        created: c.activated_at ? c.activated_at * 1000 : null, url: c.url }));
    } catch { /* fall through to on-chain feed */ }
    const lists = await Promise.allSettled(["solana", "bsc", "eth", "base"].map(n => geckoNew(n)));
    const rows = lists.flatMap(l => (l.status === "fulfilled" ? l.value : []));
    if (!rows.length) throw new Error("COINGECKO_UNAVAILABLE");
    return newest(dedupe(rows)).slice(0, 60).map(r => item("coingecko", r));
  },

  async pumpfun() {
    try {
      const d = await getJson("https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false");
      const rows = (Array.isArray(d) ? d : []).filter(c => c && c.mint).map(c => item("pumpfun", {
        chain: "solana", dex: "pumpfun", name: c.name, symbol: c.symbol, address: c.mint, pair: c.bonding_curve || c.mint,
        marketCap: c.usd_market_cap ?? c.market_cap, created: c.created_timestamp, image: c.image_uri, url: `https://pump.fun/coin/${c.mint}`
      }));
      if (rows.length) return rows;
    } catch { /* pump.fun API blocked from this server: use the aggregators below */ }
    const [gt, dx] = await Promise.allSettled([geckoNew("solana"), dexRows()]);
    const rows = [...(gt.status === "fulfilled" ? gt.value : []), ...(dx.status === "fulfilled" ? dx.value : [])]
      .filter(r => r.chain === "solana" && /pump/i.test(r.dex));
    if (!rows.length && gt.status === "rejected" && dx.status === "rejected") throw new Error("PUMPFUN_UNAVAILABLE");
    return newest(dedupe(rows)).map(r => item("pumpfun", { ...r, url: `https://pump.fun/coin/${r.address}` }));
  },

  async pancakeswap() {
    const [a, b, dx] = await Promise.allSettled([geckoNew("bsc", 1), geckoNew("bsc", 2), dexRows()]);
    const ok = x => (x.status === "fulfilled" ? x.value : []);
    if ([a, b, dx].every(x => x.status === "rejected")) throw new Error("PANCAKESWAP_UNAVAILABLE");
    const rows = [...ok(a), ...ok(b), ...ok(dx)].filter(r => r.chain === "bsc" && /pancake/i.test(r.dex));
    return newest(dedupe(rows)).map(r => item("pancakeswap", { ...r, url: dexUrl(r) || r.url }));
  },

  async solana() {
    const [a, b, dx] = await Promise.allSettled([geckoNew("solana", 1), geckoNew("solana", 2), dexRows()]);
    const ok = x => (x.status === "fulfilled" ? x.value : []);
    if ([a, b, dx].every(x => x.status === "rejected")) throw new Error("SOLANA_UNAVAILABLE");
    const rows = [...ok(a), ...ok(b), ...ok(dx)].filter(r => r.chain === "solana");
    return newest(dedupe(rows)).map(r => item(/pump/i.test(r.dex) ? "pumpfun" : "solana", { ...r, url: dexUrl(r) || r.url }));
  }
};

export async function newCoinsFeed(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (rateLimited(req, res, "launch-feed", clientKey(req), 60)) return;
  const q = new URL(req.url, "https://x").searchParams.get("source");
  const source = q === "all" || SOURCES.includes(q) ? q : "all";
  try {
    let items, failed = [];
    if (source === "all") {
      const names = SOURCES;
      const out = await Promise.allSettled(names.map(n => cached(`feed:src:${n}`, TTL, loaders[n])));
      const seen = new Set(); items = [];
      out.forEach((r, i) => {
        if (r.status !== "fulfilled") { failed.push(names[i]); return; }
        for (const it of r.value) {
          const k = it.chain + ":" + it.address.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k); items.push(it);
        }
      });
      if (!items.length) throw new Error("ALL_SOURCES_FAILED");
      newest(items); items = items.slice(0, 80);
    } else {
      items = (await cached(`feed:src:${source}`, TTL, loaders[source])).slice(0, 60);
    }
    res.setHeader("Cache-Control", "public, max-age=20, s-maxage=20");
    return send(res, 200, { ok: true, source, failed, updatedAt: new Date().toISOString(), items });
  } catch (e) {
    console.error("NEWCOINS_ERROR", source, e && e.message);
    return send(res, 502, { ok: false, error: "FEED_UPSTREAM_FAILED" });
  }
}
