// DexScreener data for the app: trending coins, new pairs, buy/sell pressure, search, pair detail, narratives.
// Public API, no key needed. Official limits: pairs/search/tokens 300 req/min, profiles/boosts/metas 60 req/min.
// Every upstream call is cached here (and de-duplicated), so many users share the same few requests.
import { send, methodNotAllowed } from "./http.js";
import { rateLimited, clientKey } from "./ratelimit.js";

const BASE = "https://api.dexscreener.com";
const CHAIN_RE = /^[a-z0-9-]{2,30}$/;
const ADDR_RE = /^[A-Za-z0-9_-]{20,90}$/;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const TFS = ["m5", "h1", "h6", "h24"];

/* ---------------------------------- upstream + cache ---------------------------------- */
const cache = new Map(); // path -> { t, data, p }
export const clearDexCache = () => cache.clear();

async function getJ(path, ttl) {
  const now = Date.now();
  const c = cache.get(path);
  if (c && c.data !== undefined && now - c.t < ttl) return c.data;
  if (c && c.p) return c.p; // same request already running
  const p = (async () => {
    const r = await fetch(BASE + path, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error("UPSTREAM_" + r.status);
    return r.json();
  })();
  cache.set(path, { t: c ? c.t : 0, data: c ? c.data : undefined, p });
  try {
    const data = await p;
    cache.set(path, { t: Date.now(), data });
    if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.t > 600000) cache.delete(k);
    return data;
  } catch (e) {
    if (c && c.data !== undefined) { // upstream failed: keep serving the last good copy, retry in ~15s
      cache.set(path, { t: Date.now() - ttl + 15000, data: c.data });
      return c.data;
    }
    cache.delete(path);
    throw e;
  }
}

/* ---------------------------------- shaping ---------------------------------- */
const n = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const https = u => (typeof u === "string" && /^https:\/\//i.test(u) && u.length < 500 ? u : null);
const arr = d => (Array.isArray(d) ? d : d && Array.isArray(d.data) ? d.data : d && typeof d === "object" && d.chainId ? [d] : []);
const pickTf = o => { const r = {}; for (const k of TFS) r[k] = n(o && o[k]); return r; };
const txnsOf = o => { const r = {}; for (const k of TFS) { const t = (o && o[k]) || {}; r[k] = { buys: n(t.buys) || 0, sells: n(t.sells) || 0 }; } return r; };

function socialUrl(s) {
  const direct = https(s && s.url);
  if (direct) return direct;
  const h = String((s && s.handle) || "");
  if (!/^[A-Za-z0-9_]{1,40}$/.test(h)) return null;
  const p = String((s && (s.platform || s.type)) || "").toLowerCase();
  return p === "twitter" ? "https://x.com/" + h : p === "telegram" ? "https://t.me/" + h : null;
}

export function shapePair(p) {
  const info = p.info || {};
  return {
    chain: String(p.chainId || ""), dex: String(p.dexId || ""), pair: String(p.pairAddress || ""), url: https(p.url),
    base: { address: String((p.baseToken && p.baseToken.address) || ""), name: String((p.baseToken && p.baseToken.name) || ""), symbol: String((p.baseToken && p.baseToken.symbol) || "") },
    quote: { address: String((p.quoteToken && p.quoteToken.address) || ""), symbol: String((p.quoteToken && p.quoteToken.symbol) || "") },
    priceUsd: n(p.priceUsd), priceNative: n(p.priceNative),
    change: pickTf(p.priceChange), volume: pickTf(p.volume), txns: txnsOf(p.txns),
    liquidity: n(p.liquidity && p.liquidity.usd), fdv: n(p.fdv), marketCap: n(p.marketCap),
    created: n(p.pairCreatedAt), image: https(info.imageUrl), header: https(info.header),
    websites: (info.websites || []).map(w => https(w && w.url)).filter(Boolean).slice(0, 3),
    socials: (info.socials || []).map(s => ({ type: String((s && (s.type || s.platform)) || "").slice(0, 20), url: socialUrl(s) })).filter(s => s.url).slice(0, 5),
    boosts: n(p.boosts && p.boosts.active) || 0,
    labels: Array.isArray(p.labels) ? p.labels.slice(0, 4).map(String) : []
  };
}

const bestPerToken = (pairs, addr) => {
  const a = String(addr).toLowerCase();
  const mine = pairs.filter(p => String((p.baseToken && p.baseToken.address) || "").toLowerCase() === a);
  mine.sort((x, y) => ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0));
  return mine[0] || null;
};

// refs: [{ chainId, tokenAddress, ...extra }] -> shaped items in the same order (tokens without a trading pair are skipped)
async function enrich(refs) {
  const byChain = new Map();
  for (const r of refs) {
    if (!r || !CHAIN_RE.test(r.chainId) || !ADDR_RE.test(r.tokenAddress)) continue;
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, []);
    byChain.get(r.chainId).push(r);
  }
  const jobs = [];
  for (const [chain, list] of byChain) {
    for (let i = 0; i < list.length && jobs.length < 12; i += 30) {
      const chunk = list.slice(i, i + 30);
      jobs.push(getJ(`/tokens/v1/${chain}/${chunk.map(x => x.tokenAddress).join(",")}`, 30000)
        .then(d => ({ chunk, pairs: Array.isArray(d) ? d : [] })).catch(() => ({ chunk, pairs: [] })));
    }
  }
  const found = new Map();
  for (const { chunk, pairs } of await Promise.all(jobs)) {
    for (const r of chunk) {
      const best = bestPerToken(pairs, r.tokenAddress);
      if (best) found.set(r.chainId + ":" + r.tokenAddress.toLowerCase(), shapePair(best));
    }
  }
  const out = [], seen = new Set();
  for (const r of refs) {
    const key = r.chainId + ":" + String(r.tokenAddress).toLowerCase();
    const it = found.get(key);
    if (!it || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, boostTotal: n(r.totalAmount) || 0, description: r.description ? String(r.description).slice(0, 240) : null, icon: it.image || https(r.icon) });
  }
  return out;
}

/* ---------------------------------- data sets ---------------------------------- */
const dedupeRefs = list => { const s = new Set(); return list.filter(r => { const k = r.chainId + ":" + String(r.tokenAddress).toLowerCase(); if (s.has(k)) return false; s.add(k); return true; }); };

export async function trendingItems(source) {
  const path = source === "latest" ? "/token-boosts/latest/v1" : "/token-boosts/top/v1";
  const refs = dedupeRefs(arr(await getJ(path, 60000))).slice(0, 40);
  return enrich(refs);
}

export async function newItems(source) {
  const path = source === "updates" ? "/token-profiles/recent-updates/v1" : source === "boosts" ? "/token-boosts/latest/v1" : "/token-profiles/latest/v1";
  const refs = dedupeRefs(arr(await getJ(path, 60000))).slice(0, 40);
  const items = await enrich(refs);
  return items.sort((a, b) => (b.created || 0) - (a.created || 0)); // newest pair first
}

export async function buySellItems(tf, sort) {
  const t = TFS.includes(tf) ? tf : "h1";
  const sets = await Promise.all([trendingItems("top"), trendingItems("latest"), newItems("profiles")].map(p => p.catch(() => [])));
  const seen = new Set(), rows = [];
  for (const it of sets.flat()) {
    const k = it.chain + ":" + it.pair;
    if (seen.has(k)) continue;
    seen.add(k);
    const x = it.txns[t], total = x.buys + x.sells;
    if (total < 10) continue;
    rows.push({ ...it, tf: t, buys: x.buys, sells: x.sells, buyPct: x.buys / total * 100 });
  }
  const by = { buys: (a, b) => b.buys - a.buys, sells: (a, b) => b.sells - a.sells, volume: (a, b) => (b.volume[t] || 0) - (a.volume[t] || 0), buyPct: (a, b) => b.buyPct - a.buyPct };
  return rows.sort(by[sort] || by.buyPct).slice(0, 60);
}

export async function searchItems(q) {
  const d = await getJ("/latest/dex/search?q=" + encodeURIComponent(q), 20000);
  const pairs = Array.isArray(d && d.pairs) ? d.pairs : [];
  return pairs.map(shapePair).sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0)).slice(0, 40);
}

const shapeMeta = m => ({
  name: String(m.name || "").slice(0, 60), slug: String(m.slug || ""), description: m.description ? String(m.description).slice(0, 200) : null,
  icon: m.icon && typeof m.icon === "object" ? { type: String(m.icon.type || ""), value: String(m.icon.value || "").slice(0, 200) } : null,
  marketCap: n(m.marketCap), liquidity: n(m.liquidity), volume: n(m.volume), tokenCount: n(m.tokenCount), change: pickTf(m.marketCapChange)
});

/* ---------------------------------- HTTP ---------------------------------- */
const bad = (res, error = "INVALID_REQUEST") => send(res, 400, { ok: false, error });

export async function dexApi(req, res, path) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (rateLimited(req, res, "dex", clientKey(req), 90)) return;
  const q = new URL(req.url, "https://x.invalid").searchParams;
  const ok = body => send(res, 200, { ok: true, updatedAt: new Date().toISOString(), ...body });
  try {
    switch (path) {
      case "/api/dex/trending": {
        const source = q.get("source") === "latest" ? "latest" : "top";
        return ok({ source, items: await trendingItems(source) });
      }
      case "/api/dex/new": {
        const s = q.get("source");
        const source = s === "updates" || s === "boosts" ? s : "profiles";
        return ok({ source, items: await newItems(source) });
      }
      case "/api/dex/buysell": {
        const tf = TFS.includes(q.get("tf")) ? q.get("tf") : "h1";
        const sort = ["buyPct", "buys", "sells", "volume"].includes(q.get("sort")) ? q.get("sort") : "buyPct";
        return ok({ tf, sort, items: await buySellItems(tf, sort) });
      }
      case "/api/dex/search": {
        const term = String(q.get("q") || "").replace(/[\u0000-\u001f]/g, "").trim();
        if (term.length < 2 || term.length > 80) return bad(res, "INVALID_QUERY");
        return ok({ q: term, items: await searchItems(term) });
      }
      case "/api/dex/pair": {
        const chain = String(q.get("chain") || "").toLowerCase(), pair = String(q.get("pair") || "");
        if (!CHAIN_RE.test(chain) || !ADDR_RE.test(pair)) return bad(res);
        const d = await getJ(`/latest/dex/pairs/${chain}/${pair}`, 10000);
        const p = (Array.isArray(d && d.pairs) && d.pairs[0]) || (d && d.pair) || null;
        if (!p) return send(res, 404, { ok: false, error: "PAIR_NOT_FOUND" });
        return ok({ item: shapePair(p) });
      }
      case "/api/dex/token": { // every pool of one token (for the "other pools" list)
        const chain = String(q.get("chain") || "").toLowerCase(), address = String(q.get("address") || "");
        if (!CHAIN_RE.test(chain) || !ADDR_RE.test(address)) return bad(res);
        const d = await getJ(`/token-pairs/v1/${chain}/${address}`, 20000);
        const items = (Array.isArray(d) ? d : []).map(shapePair).sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0)).slice(0, 12);
        return ok({ items });
      }
      case "/api/dex/metas": {
        const d = await getJ("/metas/trending/v1", 60000);
        return ok({ items: (Array.isArray(d) ? d : []).map(shapeMeta).filter(m => SLUG_RE.test(m.slug)).slice(0, 30) });
      }
      case "/api/dex/meta": {
        const slug = String(q.get("slug") || "").toLowerCase();
        if (!SLUG_RE.test(slug)) return bad(res);
        const d = await getJ(`/metas/meta/v1/${slug}`, 60000);
        const items = (Array.isArray(d && d.pairs) ? d.pairs : []).map(shapePair).sort((a, b) => (b.volume.h24 || 0) - (a.volume.h24 || 0)).slice(0, 40);
        return ok({ meta: shapeMeta(d || {}), items });
      }
      default:
        return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
    }
  } catch (e) {
    console.error("DEX_ERROR", path, e && e.message);
    return send(res, 502, { ok: false, error: "DEX_UPSTREAM_FAILED" });
  }
}

// Phase 3 (community notifications): best trading pair of ONE token, shaped like the rest of this module.
// Returns null when DEX Screener has no pair for it; THROWS on upstream failure so callers can say "unavailable".
// Deliberately NOT built on getJ(): that helper serves the last good copy when the API is down, which would put an old price next
// to a fresh "updated" time. Here a result is reused for at most 20 s and never after a failure.
const snapCache = new Map();
export async function tokenSnapshot(chainId, address) {
  if (!CHAIN_RE.test(chainId) || !ADDR_RE.test(address)) return null;
  const key = chainId + ":" + address.toLowerCase(), hit = snapCache.get(key);
  if (hit && Date.now() - hit.t < 20000) return hit.v;
  const r = await fetch(`${BASE}/tokens/v1/${chainId}/${address}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("UPSTREAM_" + r.status);
  const pairs = await r.json(), best = bestPerToken(Array.isArray(pairs) ? pairs : [], address), v = best ? shapePair(best) : null;
  if (snapCache.size > 200) snapCache.clear();
  snapCache.set(key, { t: Date.now(), v });
  return v;
}
