// Token detail data for ANY coin shown in the Launchpad (Pump.fun, PancakeSwap, Solana, DexScreener, CoinGecko, created here).
//   GET  /api/token/overview?chain=&address=&pair=    price, mcap, liquidity, volume, buys/sells, links, how it can be traded
//   GET  /api/token/ohlcv?chain=&pool=&tf=            candles (GeckoTerminal)
//   GET  /api/token/trades?chain=&pool=               latest buys / sells (GeckoTerminal)
//   GET  /api/token/holders?chain=&address=&pool=     top holders (Solana: RPC; EVM: GeckoTerminal summary, list needs MORALIS_API_KEY)
//   GET  /api/token/depth?chain=&address=&pool=       "order book": price impact for buy / sell sizes (Solana: Jupiter quotes, else estimated)
//   GET  /api/token/quote?mint=&side=&amount=         Solana swap quote (Jupiter)
//   POST /api/token/swap (login)                      builds the UNSIGNED Solana swap transaction (Jupiter); the user signs in Phantom
// DEX pools (Uniswap / Pancake / Raydium style) have no real order book, so "depth" shows what a trade of each size would cost.
// Env: SOLANA_RPC_URL, JUPITER_API_KEY (free, portal.jup.ag; recommended), JUPITER_API_BASE (optional), MORALIS_API_KEY (optional, EVM holders).
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited, clientKey } from "./ratelimit.js";

const GT = "https://api.geckoterminal.com/api/v2";
const WSOL = "So11111111111111111111111111111111111111112";
const NET = { solana: "solana", bsc: "bsc", ethereum: "eth", eth: "eth", base: "base", arbitrum: "arbitrum", polygon: "polygon_pos", polygon_pos: "polygon_pos",
  avalanche: "avax", avax: "avax", optimism: "optimism" };
const LIFI = { eth: 1, bsc: 56, polygon_pos: 137, arbitrum: 42161, base: 8453, optimism: 10, avax: 43114 };
const MORALIS = { eth: "eth", bsc: "bsc", polygon_pos: "polygon", arbitrum: "arbitrum", base: "base", optimism: "optimism", avax: "avalanche" };
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const POOL_RE = /^[A-Za-z0-9]{32,66}$/;
const TF = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };

/* ------------------------------ helpers ------------------------------ */
const store = new Map();
async function cached(key, ttl, fn) {
  const c = store.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); store.set(key, { t: Date.now(), v }); if (store.size > 800) for (const [k, x] of store) if (Date.now() - x.t > 600000) store.delete(k); return v; }
  catch (e) { if (c) return c.v; throw e; }                    // upstream down: serve the last good copy
}
async function getJson(url, headers = {}, ms = 9000) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("UPSTREAM_" + r.status);
  return r.json();
}
const gt = path => getJson(GT + path, { Accept: "application/json;version=20230302" });
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const https = u => (typeof u === "string" && /^https:\/\//i.test(u) && u.length < 500 && !/missing/i.test(u) ? u : null);
const rpcUrl = () => process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
async function rpc(method, params) {
  const r = await fetch(rpcUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(9000) });
  const j = await r.json(); if (j.error) throw new Error("RPC_" + (j.error.code ?? "ERR")); return j.result;
}
function parseTarget(q) {
  const net = NET[String(q.get("chain") || "").toLowerCase()] || null;
  const address = String(q.get("address") || ""), pair = String(q.get("pair") || q.get("pool") || "");
  if (!net) return { error: "UNSUPPORTED_CHAIN" };
  const okAddr = net === "solana" ? SOL_RE.test(address) : EVM_RE.test(address);
  if (!okAddr && address) return { error: "INVALID_ADDRESS" };
  if (pair && !POOL_RE.test(pair)) return { error: "INVALID_POOL" };
  return { net, address, pair };
}
const tradeMode = (net, address) => (net === "solana" ? { kind: "jupiter" } : LIFI[net] ? { kind: "lifi", chainId: LIFI[net], token: address } : { kind: null });

/* ------------------------------ GeckoTerminal ------------------------------ */
async function topPool(net, address) {
  return cached(`tp:${net}:${address}`, 120000, async () => {
    const d = await gt(`/networks/${net}/tokens/${address}/pools?page=1`);
    const rows = d.data || [];
    const mine = rows.find(p => String(p.relationships?.base_token?.data?.id || "").toLowerCase().endsWith(address.toLowerCase())) || rows[0];
    return mine ? mine.attributes.address : null;
  });
}
async function poolInfo(net, pool) {
  return cached(`pool:${net}:${pool}`, 15000, async () => {
    const d = await gt(`/networks/${net}/pools/${pool}?include=base_token,quote_token,dex`);
    const a = d.data?.attributes || {}, tok = new Map();
    for (const i of d.included || []) if (i.type === "token") tok.set(i.id, i.attributes || {});
    const rel = d.data?.relationships || {};
    const base = tok.get(rel.base_token?.data?.id) || {}, quote = tok.get(rel.quote_token?.data?.id) || {};
    const tf = o => ({ m5: num(o?.m5), h1: num(o?.h1), h6: num(o?.h6), h24: num(o?.h24) });
    const tx = k => ({ buys: num(a.transactions?.[k]?.buys) || 0, sells: num(a.transactions?.[k]?.sells) || 0, buyers: num(a.transactions?.[k]?.buyers), sellers: num(a.transactions?.[k]?.sellers) });
    return {
      pool: a.address || pool, name: str(a.name, 80), dex: str(rel.dex?.data?.id, 40),
      base: { address: str(base.address, 90), name: str(base.name, 60), symbol: str(base.symbol, 20), image: https(base.image_url), decimals: num(base.decimals) },
      quote: { address: str(quote.address, 90), symbol: str(quote.symbol, 20) },
      priceUsd: num(a.base_token_price_usd), priceQuote: num(a.base_token_price_quote_token),
      change: tf(a.price_change_percentage), volume: tf(a.volume_usd), txns: { m5: tx("m5"), h1: tx("h1"), h6: tx("h6"), h24: tx("h24") },
      liquidity: num(a.reserve_in_usd), fdv: num(a.fdv_usd), marketCap: num(a.market_cap_usd), created: Date.parse(a.pool_created_at) || null
    };
  });
}
const tokenInfo = (net, address) => cached(`ti:${net}:${address}`, 600000, async () => {
  const a = (await gt(`/networks/${net}/tokens/${address}/info`)).data?.attributes || {};
  const h = a.holders || {}, d = h.distribution_percentage || {};
  return {
    description: str(a.description, 600), image: https(a.image_url),
    websites: (a.websites || []).map(https).filter(Boolean).slice(0, 3),
    twitter: a.twitter_handle && /^[A-Za-z0-9_]{1,30}$/.test(a.twitter_handle) ? "https://x.com/" + a.twitter_handle : null,
    telegram: a.telegram_handle && /^[A-Za-z0-9_]{3,40}$/.test(a.telegram_handle) ? "https://t.me/" + a.telegram_handle : null,
    holders: { count: num(h.count), top10: num(d.top_10), next20: num(d["11_30"]), next20b: num(d["31_50"]), rest: num(d.rest) },
    gtScore: num(a.gt_score)
  };
});
async function resolve(net, address, pair) {                 // always end up with a pool GeckoTerminal knows
  if (pair) { try { return { pool: pair, info: await poolInfo(net, pair) }; } catch { /* pair may be a bonding curve / unknown: look the token up */ } }
  if (!address) return null;
  const pool = await topPool(net, address); if (!pool) return null;
  return { pool, info: await poolInfo(net, pool) };
}

/* ------------------------------ endpoints ------------------------------ */
async function overview(req, res) {
  if (rateLimited(req, res, "tk-ov", clientKey(req), 60)) return;
  const t = parseTarget(new URL(req.url, "https://x").searchParams); if (t.error) return send(res, 400, { ok: false, error: t.error });
  let r; try { r = await resolve(t.net, t.address, t.pair); } catch { return send(res, 502, { ok: false, error: "UPSTREAM_FAILED" }); }
  if (!r) return send(res, 404, { ok: false, error: "NO_MARKET_DATA" });
  const address = t.address || r.info.base.address;
  const info = address ? await tokenInfo(t.net, address).catch(() => null) : null;
  res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");
  return send(res, 200, { ok: true, chain: t.net, address, pool: r.pool, ...r.info, info, trade: tradeMode(t.net, address) });
}

async function ohlcv(req, res) {
  if (rateLimited(req, res, "tk-ohlcv", clientKey(req), 90)) return;
  const q = new URL(req.url, "https://x").searchParams, t = parseTarget(q); if (t.error) return send(res, 400, { ok: false, error: t.error });
  const [unit, agg] = TF[q.get("tf")] || TF["15m"]; if (!t.pair) return send(res, 400, { ok: false, error: "INVALID_POOL" });
  try {
    const d = await cached(`oh:${t.net}:${t.pair}:${unit}${agg}`, 20000, () => gt(`/networks/${t.net}/pools/${t.pair}/ohlcv/${unit}?aggregate=${agg}&limit=200&currency=usd`));
    const list = d.data?.attributes?.ohlcv_list || [];
    const candles = list.map(c => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5]) }))
      .filter(c => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)).sort((a, b) => a.t - b.t);
    res.setHeader("Cache-Control", "public, max-age=15, s-maxage=15");
    return send(res, 200, { ok: true, candles });
  } catch { return send(res, 502, { ok: false, error: "UPSTREAM_FAILED" }); }
}

async function trades(req, res) {
  if (rateLimited(req, res, "tk-tr", clientKey(req), 90)) return;
  const t = parseTarget(new URL(req.url, "https://x").searchParams); if (t.error || !t.pair) return send(res, 400, { ok: false, error: t.error || "INVALID_POOL" });
  try {
    const d = await cached(`tr:${t.net}:${t.pair}`, 10000, () => gt(`/networks/${t.net}/pools/${t.pair}/trades`));
    const items = (d.data || []).slice(0, 60).map(x => {
      const a = x.attributes || {}, buy = a.kind === "buy";
      return { t: Date.parse(a.block_timestamp) || null, side: buy ? "buy" : "sell", usd: num(a.volume_in_usd),
        amount: num(buy ? a.to_token_amount : a.from_token_amount), price: num(buy ? a.price_to_in_usd : a.price_from_in_usd),
        wallet: str(a.tx_from_address, 90), tx: str(a.tx_hash, 100) };
    });
    res.setHeader("Cache-Control", "public, max-age=8, s-maxage=8");
    return send(res, 200, { ok: true, items });
  } catch { return send(res, 502, { ok: false, error: "UPSTREAM_FAILED" }); }
}

async function solHolders(mint, pool) {
  const [sup, big] = await Promise.all([rpc("getTokenSupply", [mint]), rpc("getTokenLargestAccounts", [mint])]);
  const supply = Number(sup.value.uiAmountString || 0), accs = (big.value || []).slice(0, 20);
  let owners = [];
  if (accs.length) {
    const m = await rpc("getMultipleAccounts", [accs.map(a => a.address), { encoding: "jsonParsed" }]);
    owners = (m.value || []).map(v => v?.data?.parsed?.info?.owner || null);
  }
  const list = accs.map((a, i) => {
    const amt = Number(a.uiAmountString || 0), owner = owners[i] || a.address;
    return { address: owner, amount: amt, pct: supply ? (amt / supply) * 100 : null, isPool: !!pool && (owner === pool || a.address === pool) };
  });
  return { supply, decimals: sup.value.decimals, list };
}
async function evmHolders(net, address) {
  const key = process.env.MORALIS_API_KEY, chain = MORALIS[net]; if (!key || !chain) return null;
  const d = await getJson(`https://deep-index.moralis.io/api/v2.2/erc20/${address}/owners?chain=${chain}&order=DESC&limit=20`, { "X-API-Key": key });
  return (d.result || []).slice(0, 20).map(h => ({ address: str(h.owner_address, 60), amount: num(h.balance_formatted), pct: num(h.percentage_relative_to_total_supply),
    isPool: !!h.is_contract, label: str(h.owner_address_label, 40) || null }));
}
async function holders(req, res) {
  if (rateLimited(req, res, "tk-ho", clientKey(req), 40)) return;
  const t = parseTarget(new URL(req.url, "https://x").searchParams); if (t.error || !t.address) return send(res, 400, { ok: false, error: t.error || "INVALID_ADDRESS" });
  try {
    const d = await cached(`ho:${t.net}:${t.address}`, 90000, async () => {
      const info = await tokenInfo(t.net, t.address).catch(() => null);
      if (t.net === "solana") { const h = await solHolders(t.address, t.pair); return { list: h.list, supply: h.supply, summary: info?.holders || null }; }
      const list = await evmHolders(t.net, t.address).catch(() => null);
      return { list: list || [], supply: null, summary: info?.holders || null, listUnavailable: !list };
    });
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return send(res, 200, { ok: true, ...d });
  } catch { return send(res, 502, { ok: false, error: "UPSTREAM_FAILED" }); }
}

/* ------------------------------ Jupiter (Solana swaps + real depth) ------------------------------ */
const jupBase = () => String(process.env.JUPITER_API_BASE || (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")).replace(/\/+$/, "");
const jupHeaders = () => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});
const jupQuote = (inMint, outMint, amount, slip) =>
  getJson(`${jupBase()}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slip}&restrictIntermediateTokens=true`, jupHeaders());
const decimalsOf = mint => cached(`dec:${mint}`, 3600000, async () => Number((await rpc("getTokenSupply", [mint])).value.decimals));

function toUnits(amount, decimals) {                    // "1.25" -> "1250000000" (string math, no floats)
  const s = String(amount ?? "").trim(); if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) return null;
  const [w, f = ""] = s.split("."); const n = BigInt(w + f.padEnd(decimals, "0").slice(0, decimals)); return n > 0n ? n.toString() : null;
}
async function solQuote(mint, side, amount, slip) {
  const dec = await decimalsOf(mint), sell = side === "sell";
  const units = toUnits(amount, sell ? dec : 9); if (!units) throw new Error("INVALID_AMOUNT");
  const q = await jupQuote(sell ? mint : WSOL, sell ? WSOL : mint, units, slip);
  if (!q || !q.outAmount) throw new Error("NO_ROUTE");
  return { q, outDecimals: sell ? 9 : dec };
}
async function quote(req, res) {
  if (rateLimited(req, res, "tk-q", clientKey(req), 60)) return;
  const p = new URL(req.url, "https://x").searchParams, mint = p.get("mint") || "";
  if (!SOL_RE.test(mint)) return send(res, 400, { ok: false, error: "INVALID_ADDRESS" });
  try {
    const { q, outDecimals } = await solQuote(mint, p.get("side") === "sell" ? "sell" : "buy", p.get("amount"), 100);
    return send(res, 200, { ok: true, amountOut: String(q.outAmount), outDecimals, priceImpactPct: num(q.priceImpactPct) });
  } catch (e) { return send(res, 400, { ok: false, error: String(e.message || "QUOTE_FAILED").slice(0, 60) }); }
}
async function swap(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req); if (!s) return send(res, 401, { ok: false, error: "LOGIN_REQUIRED" });
  if (rateLimited(req, res, "tk-swap", String(s.id), 30)) return;
  const b = req.body || {};
  if (!SOL_RE.test(String(b.mint || "")) || !SOL_RE.test(String(b.wallet || ""))) return send(res, 400, { ok: false, error: "INVALID_INPUT" });
  const slip = Math.min(Math.max(Math.round(Number(b.slippageBps) || 300), 10), 2500);
  try {
    const { q } = await solQuote(b.mint, b.side === "sell" ? "sell" : "buy", b.amount, slip);
    const r = await fetch(`${jupBase()}/swap`, { method: "POST", signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", Accept: "application/json", ...jupHeaders() },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: b.wallet, dynamicComputeUnitLimit: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.swapTransaction) return send(res, 400, { ok: false, error: String(j.error || j.message || "SWAP_BUILD_FAILED").slice(0, 80) });
    return send(res, 200, { ok: true, tx: j.swapTransaction, priceImpactPct: num(q.priceImpactPct) });
  } catch (e) { return send(res, 400, { ok: false, error: String(e.message || "SWAP_FAILED").slice(0, 80) }); }
}

/* ------------------------------ depth ("order book") ------------------------------ */
const pct = v => (v == null ? null : Math.round(v * 10000) / 100);
async function depth(req, res) {
  if (rateLimited(req, res, "tk-dp", clientKey(req), 30)) return;
  const t = parseTarget(new URL(req.url, "https://x").searchParams); if (t.error || !t.address) return send(res, 400, { ok: false, error: t.error || "INVALID_ADDRESS" });
  try {
    const out = await cached(`dp:${t.net}:${t.address}`, 30000, async () => {
      if (t.net === "solana") {                                           // real quotes: what the best route would charge
        try {
          const dec = await decimalsOf(t.address), sizes = [0.5, 2, 10, 50];
          const rows = await Promise.all(sizes.map(async sol => {
            const buy = await jupQuote(WSOL, t.address, toUnits(String(sol), 9), 100);
            const sell = await jupQuote(t.address, WSOL, String(buy.outAmount), 100);
            return { label: sol + " SOL", buyImpact: pct(num(buy.priceImpactPct)), sellImpact: pct(num(sell.priceImpactPct)),
              tokens: Number(buy.outAmount) / 10 ** dec, solBack: Number(sell.outAmount) / 1e9 };
          }));
          return { source: "jupiter", rows };
        } catch { /* Jupiter unreachable / not routable: fall through to the estimate */ }
      }
      const r = await resolve(t.net, t.address, t.pair), L = r?.info?.liquidity;
      if (!L) return { source: "none", rows: [] };
      const Q = L / 2;                                                    // constant-product pool: about half the USD value on each side
      return { source: "estimate", liquidity: L, rows: [100, 500, 1000, 5000, 10000, 50000].map(x => ({ label: "$" + x.toLocaleString("en-US"),
        buyImpact: pct(x / (Q + x)), sellImpact: pct(x / (Q + x)) })) };
    });
    res.setHeader("Cache-Control", "public, max-age=20, s-maxage=20");
    return send(res, 200, { ok: true, ...out });
  } catch { return send(res, 502, { ok: false, error: "UPSTREAM_FAILED" }); }
}

export async function tokenApi(req, res, path) {
  try {
    if (path === "/api/token/swap") return await swap(req, res);
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (path === "/api/token/overview") return await overview(req, res);
    if (path === "/api/token/ohlcv") return await ohlcv(req, res);
    if (path === "/api/token/trades") return await trades(req, res);
    if (path === "/api/token/holders") return await holders(req, res);
    if (path === "/api/token/depth") return await depth(req, res);
    if (path === "/api/token/quote") return await quote(req, res);
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    console.error("TOKENVIEW_ERROR", path, e && e.message);
    return send(res, 500, { ok: false, error: "TOKEN_VIEW_FAILED" });
  }
}
