// GET /api/pnl?days=1|7|30[&wallet=network:address]
// Trading PnL (realized / unrealized / win-rate / best / worst) for the user's saved wallets.
//   EVM      : Etherscan V2 (needs ETHERSCAN_API_KEY)
//   Solana   : Helius Enhanced Transactions (needs HELIUS_API_KEY)
//   Tron     : TronGrid TRC20 (token <-> USDT/USDC swaps only)
//   TON      : TONCenter v3 jetton_swap actions (optional TONCENTER_API_KEY)
// Trades are cached per wallet in pnl_cache and merged on every refresh, so history grows beyond one API page.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { SUPPORTED, validAddr, fetchPrices, j, rpc, EVM } from "./balances.js";
import { limitsFor } from "./plans.js";
import { analyticsAccess, FREE_HISTORY_DAYS } from "./entitle.js";
import { parseEvm, parseHelius, parseSolanaRpc, parseTon, parseTron, mergeTrades, NATIVE_SYM } from "./pnl_engine.js";
import { computePnlLive } from "./live_price.js";
import { trackUsage } from "./usage.js";

const CHAIN_ID = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
const CG_ID = { ETH: "ethereum", BNB: "binancecoin", POL: "matic-network", AVAX: "avalanche-2", TRX: "tron", SOL: "solana", TON: "the-open-network" };
const CACHE_TTL_MS = 5 * 60 * 1000, MAX_WALLETS = 5, MAX_CATEGORY_WALLETS = 30, FETCH_BUDGET_MS = 7000, DAY = 86400000;
// History depth (pagination). Before: EVM 100 transfers/list, Solana 30. Now every source is paged up to N pages.
// PNL_PAGES (default 3) is the normal depth; a "deep" analyze (paid / trial / boost) uses PNL_DEEP_PAGES (default 8).
const clampPages = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), 15);
const DEFAULT_PAGES = clampPages(process.env.PNL_PAGES, 3), DEEP_PAGES = clampPages(process.env.PNL_DEEP_PAGES, 8);
const TRADE_CAP = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Keyless Etherscan-compatible indexers: cover chains the Etherscan free plan dropped (BSC has no keyless indexer; it needs an Etherscan plan that covers it).
const KEYLESS = {
  ethereum: "https://eth.blockscout.com/api", optimism: "https://optimism.blockscout.com/api", base: "https://base.blockscout.com/api",
  arbitrum: "https://arbitrum.blockscout.com/api", polygon: "https://polygon.blockscout.com/api",
  avalanche: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api"
};
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
// One Etherscan-style call with retry on rate limit (free key = ~3 calls/sec).
async function esCall(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await j(url);
      if (Array.isArray(r.result)) return r.result;
      if (r.message === "No transactions found") return [];
      const text = String((typeof r.result === "string" && r.result) || r.message || "");
      if (/rate limit/i.test(text)) { last = new Error("UPSTREAM_429"); await sleep(1100); continue; }
      if (/not supported|upgrade|plan/i.test(text)) throw new Error("INDEXER_PLAN_LIMIT");
      if (/api key/i.test(text)) throw new Error("UPSTREAM_403");
      throw new Error("INDEXER_ERROR");
    } catch (e) {
      last = e;
      if (e.message === "UPSTREAM_429" && attempt < 2) { await sleep(1100); continue; }
      throw e;
    }
  }
  throw last || new Error("INDEXER_ERROR");
}
async function esTrades(network, wallet, root, extra, priceAt, pages = DEFAULT_PAGES) {
  const q = (action, page) => `${root}${root.includes("?") ? "&" : "?"}${new URLSearchParams({ module: "account", action, address: wallet, page: String(page), offset: "100", sort: "desc", ...extra })}`;
  // Each list is paged independently and only while the previous page was full (100 rows) -> no wasted calls for small wallets.
  const paged = async action => {
    const all = [];
    for (let page = 1; page <= pages; page++) {
      const rows = await esCall(q(action, page)); await sleep(350);   // sequential on purpose: avoids burst rate limits
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  };
  const txlist = await paged("txlist");
  const tokentx = await paged("tokentx");
  const internal = await paged("txlistinternal");
  return parseEvm({ network, wallet, txlist, tokentx, internal, priceAt });
}
// ---------- BNB Smart Chain via NodeReal MegaNode (free key; Etherscan free plan no longer covers BSC) ----------
// Transfers are converted to Etherscan-style rows so the same parseEvm swap detection is used for every EVM chain.
const nodeRealKey = () => clean(process.env.NODEREAL_API_KEY);
async function nrTransfers(url, wallet, addressType) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nr_getTransactionByAddress",
      params: [{ category: ["external", "internal", "20"], address: wallet, addressType, order: "desc", maxCount: "0x64", fromBlock: "0x0", toBlock: "latest" }] }) });
    if (!r.error) return (r.result && r.result.transfers) || [];
    const msg = String(r.error.message || "");
    if (attempt === 0 && /per second/i.test(msg)) { await sleep(1200); continue; }
    throw new Error(/unauthorized|invalid/i.test(msg) ? "UPSTREAM_403" : /per second/i.test(msg) ? "UPSTREAM_429" : /ran out of cu/i.test(msg) ? "INDEXER_PLAN_LIMIT" : "INDEXER_ERROR");
  }
  return [];
}
const hexBig = h => { try { return BigInt(h).toString(); } catch { return "0"; } };
async function bscTrades(wallet, priceAt) {
  const url = `https://bsc-mainnet.nodereal.io/v1/${encodeURIComponent(nodeRealKey())}`;
  const from = await nrTransfers(url, wallet, "from"); await sleep(300);   // sequential: free key has a per-second cap
  const to = await nrTransfers(url, wallet, "to");
  const seen = new Set(), txlist = [], tokentx = [], internal = [];
  for (const t of [...from, ...to]) {
    const k = [t.hash, t.category, t.from, t.to, t.value, t.contractAddress].join(":");
    if (seen.has(k)) continue; seen.add(k);
    const ts = Number(t.blockTimeStamp ?? t.blockTimestamp); if (!(ts > 0)) continue;
    const base = { hash: t.hash, timeStamp: String(ts), from: t.from, to: t.to, value: hexBig(t.value), isError: Number(t.receiptsStatus) === 0 && t.receiptsStatus != null ? "1" : "0", gasUsed: "0", gasPrice: "0" };
    if (t.category === "external") txlist.push(base);
    else if (t.category === "internal") internal.push(base);
    else if (t.category === "20") tokentx.push({ ...base, tokenDecimal: String(parseInt(t.decimal, 16) || 18), tokenSymbol: t.asset, contractAddress: t.contractAddress });
  }
  return parseEvm({ network: "bsc", wallet, txlist, tokentx, internal, priceAt });
}
async function evmTrades(network, wallet, priceAt, pages = DEFAULT_PAGES) {
  const key = clean(process.env.ETHERSCAN_API_KEY);
  const steps = [];
  if (network === "bsc" && nodeRealKey()) steps.push(() => bscTrades(wallet, priceAt));
  if (key) steps.push(() => esTrades(network, wallet, "https://api.etherscan.io/v2/api", { chainid: CHAIN_ID[network], apikey: key }, priceAt, pages));
  if (KEYLESS[network]) steps.push(() => esTrades(network, wallet, KEYLESS[network], {}, priceAt, pages));
  if (!steps.length) throw new Error(network === "bsc" ? "BSC_INDEXER_UNAVAILABLE" : "INDEXER_NOT_CONFIGURED");
  let firstErr;
  for (const step of steps) { try { return await step(); } catch (e) { firstErr = firstErr || e; } }
  throw firstErr;
}
// Solana: Helius when a key is set (paged with the `before` cursor); otherwise (or if Helius fails) plain RPC fallback.
async function solanaRpcTrades(wallet, priceAt, pages = DEFAULT_PAGES) {
  const url = process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com";
  const want = Math.min(30 * Math.max(1, Math.ceil(pages / 3)), 90);          // RPC fallback is slow (1 call per tx): 30 normally, up to 90 on deep
  const list = [];
  let before;
  while (list.length < want) {
    const sigs = await rpc(url, "getSignaturesForAddress", [wallet, { limit: Math.min(30, want - list.length), ...(before ? { before } : {}) }]);
    const arr = Array.isArray(sigs) ? sigs : [];
    list.push(...arr.filter(x => !x.err).map(x => x.signature));
    if (arr.length < 30) break;
    before = arr[arr.length - 1].signature;
  }
  const txs = [];
  for (let i = 0; i < list.length; i += 4) {                       // small sequential batches keep public RPC rate limits happy
    const part = await Promise.all(list.slice(i, i + 4).map(sig => rpc(url, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]).catch(() => null)));
    txs.push(...part.filter(Boolean));
    if (i + 4 < list.length) await sleep(250);
  }
  if (list.length && !txs.length) throw new Error("UPSTREAM_429");
  return parseSolanaRpc({ wallet, txs, priceAt });
}
async function solanaTrades(wallet, priceAt, pages = DEFAULT_PAGES) {
  const key = clean(process.env.HELIUS_API_KEY);
  if (key) {
    try {
      const all = [];
      let before;
      for (let page = 0; page < pages; page++) {
        const txs = await j(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${encodeURIComponent(key)}&type=SWAP&limit=100${before ? "&before=" + encodeURIComponent(before) : ""}`);
        const arr = Array.isArray(txs) ? txs : [];
        all.push(...arr);
        if (arr.length < 100) break;
        before = arr[arr.length - 1].signature;
        await sleep(200);
      }
      return parseHelius({ wallet, txs: all, priceAt });
    } catch (e) { /* fall through to RPC */ }
  }
  return solanaRpcTrades(wallet, priceAt, pages);
}
async function tonTrades(wallet, priceAt, pages = DEFAULT_PAGES) {
  const h = process.env.TONCENTER_API_KEY ? { "X-API-Key": clean(process.env.TONCENTER_API_KEY) } : {};
  const actions = []; let metadata = {};
  for (let page = 0; page < pages; page++) {
    const r = await j(`https://toncenter.com/api/v3/actions?${new URLSearchParams({ account: wallet, action_type: "jetton_swap", limit: "100", offset: String(page * 100), sort: "desc" })}`, { headers: h });
    const arr = Array.isArray(r.actions) ? r.actions : [];
    actions.push(...arr); metadata = { ...metadata, ...(r.metadata || {}) };
    if (arr.length < 100) break;
    await sleep(1100);                                                 // TONCenter keyless limit: ~1 req/s
  }
  return parseTon({ wallet, actions, metadata, priceAt });
}
async function tronTrades(wallet, priceAt, pages = DEFAULT_PAGES) {
  const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const data = []; let fingerprint = "";
  for (let page = 0; page < pages; page++) {
    const r = await j(`https://api.trongrid.io/v1/accounts/${wallet}/transactions/trc20?limit=100&only_confirmed=true${fingerprint ? "&fingerprint=" + encodeURIComponent(fingerprint) : ""}`, { headers: h });
    const arr = r.data || [];
    data.push(...arr);
    fingerprint = r.meta?.fingerprint || "";
    if (arr.length < 100 || !fingerprint) break;
    await sleep(300);
  }
  return parseTron({ wallet, transfers: data, priceAt });
}
export const fetchTrades = (net, w, priceAt, pages = DEFAULT_PAGES) => EVM[net] ? evmTrades(net, w, priceAt, pages) : net === "solana" ? solanaTrades(w, priceAt, pages) : net === "tron" ? tronTrades(w, priceAt, pages) : net === "ton" ? tonTrades(w, priceAt, pages) : null;
export { loadNativePrices, makePriceAt };

const ERR_TEXT = {
  INDEXER_NOT_CONFIGURED: "EVM indexer key not configured on the server",
  HELIUS_NOT_CONFIGURED: "Solana indexer key not configured on the server",
  INDEXER_ERROR: "indexer error", INDEXER_RATE_LIMITED: "indexer rate-limited", INDEXER_PLAN_LIMIT: "indexer plan does not cover this chain", BSC_INDEXER_UNAVAILABLE: "BSC history needs NODEREAL_API_KEY (free) in Vercel env", UPSTREAM_429: "indexer rate-limited, showing cached data", UPSTREAM_403: "indexer key rejected"
};

// Shared by the /api/pnl route, Smart Money refresh and the background worker.
// wallets: [{network,address}]. Fetches stale wallets one by one inside a time budget and stores them in pnl_cache.
export async function refreshPnlCache(uid, wallets, { budgetMs = FETCH_BUDGET_MS, cacheTtl = CACHE_TTL_MS, pages = DEFAULT_PAGES } = {}) {
  await ensureSchema();
  const warnings = [];
  const needNative = [...new Set(wallets.map(w => NATIVE_SYM[w.network]).filter(Boolean))];
  const rows = await Promise.all(wallets.map(async w => {
    const r = await db().query(`SELECT trades, updated_at FROM pnl_cache WHERE user_id=$1 AND network=$2 AND address=$3`, [uid, w.network, w.address]);
    const row = r.rows[0];
    const fresh = row && Date.now() - new Date(row.updated_at).getTime() < cacheTtl;
    return { ...w, cached: row?.trades || [], fresh: !!fresh };
  }));
  const needFetch = rows.filter(r => !r.fresh);
  const priceAt = needFetch.length ? makePriceAt(await loadNativePrices(needNative)) : null;

  const skippedTotal = {}, walletStatus = [];
  const t0 = Date.now();
  let pending = 0;
  // Sequential + time budget: parallel bursts hit indexer rate limits and long loops hit the serverless timeout.
  // Wallets not reached are reported as pending; calling the endpoint again continues with them (fresh ones are skipped).
  for (const w of rows) {
    const st = { network: w.network, address: w.address, status: "cached", trades: w.cached.length };
    walletStatus.push(st);
    if (w.fresh) continue;
    if (Date.now() - t0 > budgetMs) { pending++; st.status = "pending"; continue; }
    try {
      const got = await fetchTrades(w.network, w.address, priceAt, pages);
      w.cached = mergeTrades(w.cached, got.trades, TRADE_CAP);
      for (const [k, v] of Object.entries(got.skipped)) skippedTotal[k] = (skippedTotal[k] || 0) + v;
      const last = w.cached.length ? w.cached[0].ts : 0;
      await db().query(
        `INSERT INTO pnl_cache(user_id,network,address,trades,last_ts,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,NOW())
         ON CONFLICT (user_id,network,address) DO UPDATE SET trades=EXCLUDED.trades, last_ts=EXCLUDED.last_ts, updated_at=NOW()`,
        [uid, w.network, w.address, JSON.stringify(w.cached), last]);
      st.status = w.cached.length ? "indexed" : "no_swaps"; st.trades = w.cached.length;
    } catch (e) {
      console.error("[pnl]", w.network, e.message);                // message only: URLs carry API keys, never log them
      st.status = "error"; st.error = ERR_TEXT[e.message] || "data source unavailable";
      warnings.push(`${w.network} ${String(w.address).slice(0, 6)}…: ${st.error}`);
    }
  }
  if (pending) warnings.push(`${pending} wallet(s) still waiting to be indexed - run Analyze again`);
  return { rows, warnings, skippedTotal, walletStatus, pending };
}

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
    wallets = wallets.slice(0, category ? MAX_CATEGORY_WALLETS : MAX_WALLETS);

    // deep=1 (Advanced Analytics / paid / trial): fetch more pages of history now instead of waiting for the normal cache window.
    const deep = full && p.get("deep") === "1";
    const { rows, warnings, skippedTotal, walletStatus, pending } = await refreshPnlCache(s.id, wallets, deep ? { pages: DEEP_PAGES, cacheTtl: 0, budgetMs: 9000 } : {});
    if (deep) trackUsage(s.id, "pnl_deep");
    if (skippedTotal.price_missing) warnings.push(`${skippedTotal.price_missing} trade(s) skipped: no historical price`);
    if (wallets.some(w => w.network === "tron")) warnings.push("Tron: only token ↔ USDT/USDC swaps are detected");

    const live = await fetchPrices().catch(() => ({}));
    const marks = {};
    for (const w of wallets) { const sym = NATIVE_SYM[w.network]; if (live[sym]?.usd) marks[`${w.network}:native`] = live[sym].usd; }
    const all = rows.flatMap(r => r.cached);
    const out = await computePnlLive(all, { sinceTs: Date.now() - days * DAY, marks });
    if (out.unknownCostTokens) warnings.push(`${out.unknownCostTokens} token(s) were sold without a visible buy (cost unknown), excluded from realized PnL`);
    if (out.byToken.some(t => t.markSource === "last_trade")) warnings.push("Some open tokens have no liquid live market (or the price API was unreachable): their unrealized PnL uses the last trade price");
    return send(res, 200, { ok: true, locked: !full, deep, pages: deep ? DEEP_PAGES : DEFAULT_PAGES, days, wallets: wallets.length, pending, walletStatus, ...out, warnings: [...new Set(warnings)] });
  } catch (e) {
    console.error("[pnl]", e.message);
    return send(res, 500, { ok: false, error: "PNL_FAILED" });
  }
}
