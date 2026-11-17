// GET /api/pnl?days=1|7|30[&wallet=network:address]
// Trading PnL (realized / unrealized / win-rate / best / worst) for the user's saved wallets.
//   EVM      : Etherscan V2 (needs ETHERSCAN_API_KEY)
//   Solana   : Helius Enhanced Transactions (needs HELIUS_API_KEY)
//   Tron     : TronGrid TRC20 (token <-> USDT/USDC swaps only)
//   TON      : not supported yet (reported in `warnings`)
// Trades are cached per wallet in pnl_cache and merged on every refresh, so history grows beyond one API page.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { SUPPORTED, validAddr, fetchPrices, j, EVM } from "./balances.js";
import { limitsFor } from "./plans.js";
import { analyticsAccess, FREE_HISTORY_DAYS } from "./entitle.js";
import { parseEvm, parseHelius, parseTron, mergeTrades, computePnl, NATIVE_SYM } from "./pnl_engine.js";

const CHAIN_ID = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
const CG_ID = { ETH: "ethereum", BNB: "binancecoin", POL: "matic-network", AVAX: "avalanche-2", TRX: "tron", SOL: "solana" };
const CACHE_TTL_MS = 5 * 60 * 1000, MAX_WALLETS = 5, DAY = 86400000;
const clean = k => String(k || "").trim().replace(/^["']+|["']+$/g, "").trim();

// ---------- schema (created on first use, like scanner/forcejoin) ----------
let schemaP;
const ensureSchema = () => schemaP || (schemaP = db().query(
  `CREATE TABLE IF NOT EXISTS pnl_cache (
     user_id BIGINT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL,
     trades JSONB NOT NULL DEFAULT '[]', last_ts BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, network, address))`).catch(e => { schemaP = null; throw e; }));

// ---------- historical native-coin prices (CoinGecko, last 90 days = hourly points) ----------
const priceCache = new Map(); // sym -> { t, pts }
async function loadNativePrices(syms) {
  const out = {};
  await Promise.all([...new Set(syms)].map(async sym => {
    const id = CG_ID[sym]; if (!id) return;
    const hit = priceCache.get(sym);
    if (hit && Date.now() - hit.t < 10 * 60 * 1000) { out[sym] = hit.pts; return; }
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await j(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${now - 90 * 86400}&to=${now}`);
      const pts = Array.isArray(r.prices) ? r.prices : [];
      priceCache.set(sym, { t: Date.now(), pts }); out[sym] = pts;
    } catch { out[sym] = hit?.pts || []; }
  }));
  return out;
}
function makePriceAt(table) {
  return (sym, ts) => {
    const pts = table[sym]; if (!pts || !pts.length) return undefined;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < ts) lo = mid + 1; else hi = mid; }
    const cand = [pts[lo], pts[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a[0] - ts) - Math.abs(b[0] - ts))[0];
    return cand && Math.abs(cand[0] - ts) <= 36 * 3600 * 1000 ? cand[1] : undefined; // too far from any sample => unknown, not guessed
  };
}

// ---------- chain fetchers (return parsed trades) ----------
async function evmTrades(network, wallet, priceAt) {
  const key = clean(process.env.ETHERSCAN_API_KEY);
  if (!key) throw new Error("INDEXER_NOT_CONFIGURED");
  const q = action => `https://api.etherscan.io/v2/api?${new URLSearchParams({ chainid: CHAIN_ID[network], module: "account", action, address: wallet, page: "1", offset: "100", sort: "desc", apikey: key })}`;
  const arr = r => Array.isArray(r.result) ? r.result : (r.message === "No transactions found" ? [] : (() => { throw new Error("INDEXER_ERROR"); })());
  const [a, b, c] = await Promise.all([j(q("txlist")), j(q("tokentx")), j(q("txlistinternal"))]);
  return parseEvm({ network, wallet, txlist: arr(a), tokentx: arr(b), internal: arr(c), priceAt });
}
async function solanaTrades(wallet, priceAt) {
  const key = clean(process.env.HELIUS_API_KEY);
  if (!key) throw new Error("HELIUS_NOT_CONFIGURED");
  const txs = await j(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${encodeURIComponent(key)}&type=SWAP&limit=100`);
  return parseHelius({ wallet, txs: Array.isArray(txs) ? txs : [], priceAt });
}
async function tronTrades(wallet, priceAt) {
  const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const r = await j(`https://api.trongrid.io/v1/accounts/${wallet}/transactions/trc20?limit=100&only_confirmed=true`, { headers: h });
  return parseTron({ wallet, transfers: r.data || [], priceAt });
}
const fetchTrades = (net, w, priceAt) => EVM[net] ? evmTrades(net, w, priceAt) : net === "solana" ? solanaTrades(w, priceAt) : net === "tron" ? tronTrades(w, priceAt) : null;

const ERR_TEXT = {
  INDEXER_NOT_CONFIGURED: "EVM indexer key not configured on the server",
  HELIUS_NOT_CONFIGURED: "Solana indexer key not configured on the server",
  INDEXER_ERROR: "indexer error", UPSTREAM_429: "indexer rate-limited, showing cached data", UPSTREAM_403: "indexer key rejected"
};

// ---------- route ----------
export async function pnlRoute(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  if (rateLimited(req, res, "pnl", s.id, 10)) return;
  try {
    const p = new URL(req.url, "https://x.invalid").searchParams;
    const full = await analyticsAccess(s.id);                       // paid plan or MBC Points boost
    let days = [1, 7, 30].includes(Number(p.get("days"))) ? Number(p.get("days")) : 7;
    if (!full && days > FREE_HISTORY_DAYS) days = FREE_HISTORY_DAYS;
    await ensureSchema();

    // Wallets come from the user's own saved list, never from the request.
    const lim = await limitsFor(s.id).catch(() => ({ wallets: 10 }));
    const wl = await db().query(`SELECT items FROM user_watchlists WHERE user_id=$1`, [s.id]);
    const category = String(p.get("category") || "").trim();
    let items = (Array.isArray(wl.rows[0]?.items) ? wl.rows[0].items : [])
      .filter(i => i?.type === "wallet" && SUPPORTED.includes(i.network) && validAddr(i.network, i.address));
    if (category) items = items.filter(i => String(i.category || "") === category);
    let wallets = items.map(i => ({ network: i.network, address: i.address })).slice(0, lim.wallets);
    const only = String(p.get("wallet") || "");
    if (only) { const [n, ...rest] = only.split(":"), a = rest.join(":"); wallets = wallets.filter(w => w.network === n && w.address.toLowerCase() === a.toLowerCase()); }
    if (!wallets.length) return send(res, 400, { ok: false, error: "NO_WALLETS" });
    wallets = wallets.slice(0, MAX_WALLETS);

    const warnings = [];
    const needNative = [...new Set(wallets.map(w => NATIVE_SYM[w.network]).filter(Boolean))];
    const rows = await Promise.all(wallets.map(async w => {
      const r = await db().query(`SELECT trades, updated_at FROM pnl_cache WHERE user_id=$1 AND network=$2 AND address=$3`, [s.id, w.network, w.address]);
      const row = r.rows[0];
      const fresh = row && Date.now() - new Date(row.updated_at).getTime() < CACHE_TTL_MS;
      return { ...w, cached: row?.trades || [], fresh: !!fresh };
    }));
    const needFetch = rows.filter(r => !r.fresh);
    const priceAt = needFetch.length ? makePriceAt(await loadNativePrices(needNative)) : null;

    const skippedTotal = {};
    await Promise.all(rows.map(async w => {
      if (w.fresh) return;
      if (w.network === "ton") { warnings.push("TON: PnL is not supported yet"); return; }
      try {
        const got = await fetchTrades(w.network, w.address, priceAt);
        w.cached = mergeTrades(w.cached, got.trades);
        for (const [k, v] of Object.entries(got.skipped)) skippedTotal[k] = (skippedTotal[k] || 0) + v;
        const last = w.cached.length ? w.cached[0].ts : 0;
        await db().query(
          `INSERT INTO pnl_cache(user_id,network,address,trades,last_ts,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,NOW())
           ON CONFLICT (user_id,network,address) DO UPDATE SET trades=EXCLUDED.trades, last_ts=EXCLUDED.last_ts, updated_at=NOW()`,
          [s.id, w.network, w.address, JSON.stringify(w.cached), last]);
      } catch (e) {
        console.error("[pnl]", w.network, e.message);                // message only: URLs carry API keys, never log them
        warnings.push(`${w.network}: ${ERR_TEXT[e.message] || "data source unavailable"}`);
      }
    }));
    if (skippedTotal.price_missing) warnings.push(`${skippedTotal.price_missing} trade(s) skipped: no historical price`);
    if (wallets.some(w => w.network === "tron")) warnings.push("Tron: only token ↔ USDT/USDC swaps are detected");

    const live = await fetchPrices().catch(() => ({}));
    const marks = {};
    for (const w of wallets) { const sym = NATIVE_SYM[w.network]; if (live[sym]?.usd) marks[`${w.network}:native`] = live[sym].usd; }
    const all = rows.flatMap(r => r.cached);
    const out = computePnl(all, { sinceTs: Date.now() - days * DAY, marks });
    if (out.unknownCostTokens) warnings.push(`${out.unknownCostTokens} token(s) were sold without a visible buy (cost unknown), excluded from realized PnL`);
    if (out.byToken.some(t => t.markSource === "last_trade")) warnings.push("Unrealized PnL for tokens uses the last trade price, not a live price");
    return send(res, 200, { ok: true, locked: !full, days, wallets: wallets.length, ...out, warnings: [...new Set(warnings)] });
  } catch (e) {
    console.error("[pnl]", e.message);
    return send(res, 500, { ok: false, error: "PNL_FAILED" });
  }
}
