// Launchpad on Meteora's Dynamic Bonding Curve (DBC). Non-custodial: the server only BUILDS unsigned
// transactions; the user's own wallet signs and sends them. The server never holds user keys.
//   GET  /api/launch/config            public settings
//   GET  /api/launch/list              live tokens created on this launchpad (sort=new|graduating)
//   GET  /api/launch/feed              new coins from Pump.fun / PancakeSwap / Solana / DexScreener / CoinGecko (source=all|...)
//   GET  /api/launch/token?mint=       one token + curve progress
//   GET  /api/launch/meta?id=          token metadata JSON (used as the on-chain metadata URI)
//   GET  /api/launch/img?id=           token logo
//   GET  /api/launch/quote             price quote for a buy / sell
//   GET  /api/launch/balance           SOL + token balance of a wallet
//   POST /api/launch/prepare           (login) build the "create token" transaction
//   POST /api/launch/confirm           (login) verify the sent transaction on-chain, make the token live
//   POST /api/launch/swap              (login) build a buy / sell transaction
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited, clientKey } from "./ratelimit.js";
import { newCoinsFeed } from "./newcoins.js";

const WSOL = "So11111111111111111111111111111111111111112";
const ID_RE = /^[a-f0-9]{16}$/;
const MAX_IMG = 300 * 1024;
const SWAP_EXACT_IN = 0;   // SwapMode.ExactIn
const DAILY_LAUNCH_LIMIT = Number(process.env.LAUNCH_DAILY_LIMIT || 5);

let _lib;
async function lib() {
  if (_lib) return _lib;
  const web3 = await import("@solana/web3.js");
  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const BN = (await import("bn.js")).default;
  const connection = new web3.Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
  _lib = { web3, sdk, BN, connection, client };
  return _lib;
}

const configKey = () => process.env.DBC_CONFIG_KEY || "";
const origin = req => (process.env.APP_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`).replace(/\/+$/, "");
const isPk = (web3, v) => { try { return typeof v === "string" && v.length >= 32 && v.length <= 44 && !!new web3.PublicKey(v); } catch { return false; } };
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanUrl = (v, host) => {
  const s = String(v ?? "").trim().slice(0, 200); if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); if (!/^https?:$/.test(u.protocol)) return null;
    if (host && !host.test(u.hostname)) return null; return u.toString(); } catch { return null; }
};

// config state (decimals, threshold, activation type) is the same for every token: cache it
let cfgCache = { t: 0, v: null };
async function poolConfig(L) {
  if (cfgCache.v && Date.now() - cfgCache.t < 5 * 60000) return cfgCache.v;
  const v = await L.client.state.getPoolConfig(configKey());
  if (!v) return null;                       // wrong key / wrong network (devnet key on mainnet RPC, etc.)
  cfgCache = { t: Date.now(), v };
  return v;
}
const progCache = new Map();
async function progressOf(L, pool) {
  const c = progCache.get(pool);
  if (c && Date.now() - c.t < 20000) return c.v;
  let v = null;
  try { v = Number(await L.client.state.getPoolQuoteTokenCurveProgress(pool)); } catch { /* pool not found yet */ }
  progCache.set(pool, { t: Date.now(), v });
  if (progCache.size > 500) progCache.clear();
  return v;
}
const shapeRow = (r, progress) => ({
  id: r.id, mint: r.mint, pool: r.pool, name: r.name, symbol: r.symbol, description: r.description,
  twitter: r.twitter, telegram: r.telegram, website: r.website, creator: r.creator,
  image: `/api/launch/img?id=${r.id}`, createdAt: r.live_at || r.created_at, progress: progress ?? null
});

/* ----------------------------------------- public ----------------------------------------- */
async function cfg(req, res) {
  return send(res, 200, { ok: true, enabled: !!configKey(), network: process.env.LAUNCH_NETWORK || "mainnet",
    rpcLabel: process.env.SOLANA_RPC_URL ? "custom" : "public", configKey: configKey() || null });
}

async function list(req, res) {
  if (rateLimited(req, res, "launch-list", clientKey(req), 90)) return;
  const q = new URL(req.url, "https://x").searchParams;
  const sort = q.get("sort") === "graduating" ? "graduating" : "new";
  const { rows } = await db().query(
    `SELECT id,mint,pool,name,symbol,description,twitter,telegram,website,creator,created_at,live_at
       FROM launch_tokens WHERE status='live' ORDER BY live_at DESC LIMIT 40`);
  if (!rows.length) return send(res, 200, { ok: true, items: [] });   // nothing yet: no need to load the SDK
  const L = await lib();
  let items = await Promise.all(rows.map(async r => shapeRow(r, await progressOf(L, r.pool))));
  if (sort === "graduating") items = items.filter(i => i.progress !== null).sort((a, b) => b.progress - a.progress);
  res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");
  return send(res, 200, { ok: true, items });
}

async function tokenRow(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || "")) return null;
  const { rows } = await db().query(
    `SELECT id,mint,pool,name,symbol,description,twitter,telegram,website,creator,created_at,live_at
       FROM launch_tokens WHERE mint=$1 AND status='live'`, [mint]);
  return rows[0] || null;
}

async function token(req, res) {
  if (rateLimited(req, res, "launch-token", clientKey(req), 90)) return;
  const row = await tokenRow(new URL(req.url, "https://x").searchParams.get("mint"));
  if (!row) return send(res, 404, { ok: false, error: "TOKEN_NOT_FOUND" });
  const L = await lib();
  const c = await poolConfig(L).catch(() => null);
  return send(res, 200, { ok: true, token: shapeRow(row, await progressOf(L, row.pool)),
    decimals: c ? Number(c.tokenDecimal) : null });
}

async function meta(req, res) {
  const id = new URL(req.url, "https://x").searchParams.get("id") || "";
  if (!ID_RE.test(id)) return send(res, 404, { ok: false, error: "NOT_FOUND" });
  const { rows } = await db().query(`SELECT * FROM launch_tokens WHERE id=$1`, [id]);
  const r = rows[0]; if (!r) return send(res, 404, { ok: false, error: "NOT_FOUND" });
  const o = origin(req);
  res.setHeader("Cache-Control", "public, max-age=300");
  return send(res, 200, { name: r.name, symbol: r.symbol, description: r.description || "", image: `${o}/api/launch/img?id=${r.id}`,
    external_url: r.website || o, extensions: { twitter: r.twitter || undefined, telegram: r.telegram || undefined, website: r.website || undefined } });
}

async function img(req, res) {
  const id = new URL(req.url, "https://x").searchParams.get("id") || "";
  if (!ID_RE.test(id)) return res.status(404).end();
  const { rows } = await db().query(`SELECT image, image_mime FROM launch_tokens WHERE id=$1`, [id]);
  if (!rows[0]?.image) return res.status(404).end();
  res.setHeader("Content-Type", rows[0].image_mime || "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).end(rows[0].image);
}

function toUnits(BN, amount, decimals) { // "1.25" -> BN(1250000000), no float math
  const s = String(amount ?? "").trim();
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const n = new BN((w + f.padEnd(decimals, "0").slice(0, decimals)).replace(/^0+(?=\d)/, ""));
  return n.isZero() ? null : n;
}

async function buildSwap(L, row, wallet, side, amount, slippageBps) {
  const { BN, web3, client, connection } = L;
  const c = await poolConfig(L);
  if (!c) throw new Error("CONFIG_NOT_FOUND");
  const sell = side === "sell";
  const amountIn = toUnits(BN, amount, sell ? Number(c.tokenDecimal) : 9);
  if (!amountIn) throw new Error("INVALID_AMOUNT");
  const poolPk = new web3.PublicKey(row.pool);
  const state = await client.state.getPool(poolPk);
  if (!state) throw new Error("POOL_NOT_FOUND");
  const point = Number(c.activationType) === 0 ? new BN(await connection.getSlot()) : new BN(Math.floor(Date.now() / 1000));
  const quote = await client.pool.swapQuote2({ virtualPool: state, config: c, swapBaseForQuote: sell, amountIn,
    slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: point, swapMode: SWAP_EXACT_IN });
  const outAmount = quote.excludedTransferFeeAmountOut ?? quote.outputAmount ?? quote.amountOut ?? quote.minimumAmountOut;
  return { amountIn, quote, minOut: quote.minimumAmountOut, outAmount, poolPk, sell };
}

async function quote(req, res) {
  if (rateLimited(req, res, "launch-quote", clientKey(req), 60)) return;
  const q = new URL(req.url, "https://x").searchParams;
  const row = await tokenRow(q.get("mint")); if (!row) return send(res, 404, { ok: false, error: "TOKEN_NOT_FOUND" });
  const L = await lib();
  try {
    const b = await buildSwap(L, row, null, q.get("side") === "sell" ? "sell" : "buy", q.get("amount"), 100);
    const dec = b.sell ? 9 : Number((await poolConfig(L)).tokenDecimal);   // (config exists: buildSwap checked)
    return send(res, 200, { ok: true, amountOut: String(b.outAmount), minimumAmountOut: String(b.minOut), outDecimals: dec });
  } catch (e) { return send(res, 400, { ok: false, error: String(e.message || "QUOTE_FAILED").slice(0, 60) }); }
}

async function balance(req, res) {
  if (rateLimited(req, res, "launch-bal", clientKey(req), 40)) return;
  const q = new URL(req.url, "https://x").searchParams;
  const L = await lib(); const w = q.get("wallet");
  if (!isPk(L.web3, w)) return send(res, 400, { ok: false, error: "INVALID_WALLET" });
  const owner = new L.web3.PublicKey(w);
  const sol = await L.connection.getBalance(owner);
  let tokenUi = 0;
  const mint = q.get("mint");
  if (mint && isPk(L.web3, mint)) {
    const r = await L.connection.getParsedTokenAccountsByOwner(owner, { mint: new L.web3.PublicKey(mint) });
    tokenUi = r.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmountString || 0), 0);
  }
  return send(res, 200, { ok: true, sol: sol / 1e9, token: tokenUi });
}

/* ----------------------------------------- logged-in ----------------------------------------- */
async function prepare(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req); if (!s) return send(res, 401, { ok: false, error: "LOGIN_REQUIRED" });
  if (rateLimited(req, res, "launch-prepare", String(s.id), 6)) return;
  if (!configKey()) return send(res, 503, { ok: false, error: "LAUNCHPAD_NOT_CONFIGURED" });
  const L = await lib(); const b = req.body || {};

  const name = clean(b.name, 32), symbol = clean(b.symbol, 10).replace(/\s/g, "").toUpperCase();
  if (name.length < 2) return send(res, 400, { ok: false, error: "INVALID_NAME" });
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return send(res, 400, { ok: false, error: "INVALID_SYMBOL" });
  if (!isPk(L.web3, b.wallet)) return send(res, 400, { ok: false, error: "INVALID_WALLET" });
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ""));
  if (!m) return send(res, 400, { ok: false, error: "IMAGE_REQUIRED" });
  const imgBuf = Buffer.from(m[2], "base64");
  if (!imgBuf.length || imgBuf.length > MAX_IMG) return send(res, 400, { ok: false, error: "IMAGE_TOO_LARGE" });

  const day = await db().query(`SELECT COUNT(*)::int n FROM launch_tokens WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`, [s.id]);
  if (day.rows[0].n >= DAILY_LAUNCH_LIMIT) return send(res, 429, { ok: false, error: "DAILY_LAUNCH_LIMIT" });

  const { web3, sdk, client, connection } = L;
  const wallet = new web3.PublicKey(b.wallet);
  const mintKp = web3.Keypair.generate();              // one-time mint key: signs this one transaction, then is discarded
  const cfgPk = new web3.PublicKey(configKey());
  const quoteMint = new web3.PublicKey(WSOL);
  const id = crypto.randomBytes(8).toString("hex");
  const poolPk = sdk.deriveDbcPoolAddress(quoteMint, mintKp.publicKey, cfgPk);
  if (!(await poolConfig(L))) return send(res, 503, { ok: false, error: "CONFIG_NOT_FOUND_ON_THIS_NETWORK" });

  const tx = await client.creator.createPool({ baseMint: mintKp.publicKey, config: cfgPk, name, symbol,
    uri: `${origin(req)}/api/launch/meta?id=${id}`, payer: wallet, poolCreator: wallet });
  const bh = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = wallet; tx.recentBlockhash = bh.blockhash;
  tx.partialSign(mintKp);

  await db().query(
    `INSERT INTO launch_tokens (id,user_id,creator,mint,pool,name,symbol,description,twitter,telegram,website,image,image_mime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, s.id, b.wallet, mintKp.publicKey.toBase58(), poolPk.toBase58(), name, symbol, clean(b.description, 500) || null,
     cleanUrl(b.twitter, /(^|\.)(x|twitter)\.com$/i), cleanUrl(b.telegram, /(^|\.)(t\.me|telegram\.me)$/i), cleanUrl(b.website),
     imgBuf, m[1]]);

  return send(res, 200, { ok: true, id, mint: mintKp.publicKey.toBase58(), pool: poolPk.toBase58(),
    tx: tx.serialize({ requireAllSignatureVerification: false }).toString("base64") });
}

async function confirm(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req); if (!s) return send(res, 401, { ok: false, error: "LOGIN_REQUIRED" });
  if (rateLimited(req, res, "launch-confirm", String(s.id), 60)) return;
  const id = String(req.body?.id || ""), sig = String(req.body?.signature || "");
  if (!ID_RE.test(id) || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return send(res, 400, { ok: false, error: "INVALID_INPUT" });
  const { rows } = await db().query(`SELECT * FROM launch_tokens WHERE id=$1 AND user_id=$2`, [id, s.id]);
  const r = rows[0]; if (!r) return send(res, 404, { ok: false, error: "NOT_FOUND" });
  if (r.status === "live") return send(res, 200, { ok: true, status: "live", mint: r.mint });

  const L = await lib();
  const t = await L.connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t) return send(res, 202, { ok: true, status: "pending" });                 // not visible yet: client retries
  if (t.meta?.err) return send(res, 400, { ok: false, error: "TX_FAILED" });
  const keys = t.transaction.message.accountKeys.map(k => (k.pubkey ? k.pubkey.toBase58() : String(k)));
  if (keys[0] !== r.creator || !keys.includes(r.mint) || !keys.includes(r.pool)) return send(res, 400, { ok: false, error: "TX_MISMATCH" });
  await db().query(`UPDATE launch_tokens SET status='live', tx_sig=$2, live_at=NOW() WHERE id=$1`, [id, sig]);
  return send(res, 200, { ok: true, status: "live", mint: r.mint });
}

async function swap(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req); if (!s) return send(res, 401, { ok: false, error: "LOGIN_REQUIRED" });
  if (rateLimited(req, res, "launch-swap", String(s.id), 30)) return;
  const b = req.body || {}; const L = await lib();
  if (!isPk(L.web3, b.wallet)) return send(res, 400, { ok: false, error: "INVALID_WALLET" });
  const row = await tokenRow(b.mint); if (!row) return send(res, 404, { ok: false, error: "TOKEN_NOT_FOUND" });
  const slip = Math.min(Math.max(Math.round(Number(b.slippageBps) || 300), 10), 2500);
  try {
    const x = await buildSwap(L, row, b.wallet, b.side === "sell" ? "sell" : "buy", b.amount, slip);
    const owner = new L.web3.PublicKey(b.wallet);
    const tx = await L.client.pool.swap2({ owner, pool: x.poolPk, swapBaseForQuote: x.sell, amountIn: x.amountIn,
      minimumAmountOut: x.minOut, swapMode: SWAP_EXACT_IN, referralTokenAccount: null });
    const bh = await L.connection.getLatestBlockhash("confirmed");
    tx.feePayer = owner; tx.recentBlockhash = bh.blockhash;
    return send(res, 200, { ok: true, tx: tx.serialize({ requireAllSignatureVerification: false }).toString("base64") });
  } catch (e) {
    return send(res, 400, { ok: false, error: String(e.message || "SWAP_FAILED").slice(0, 80) });
  }
}

export async function launchApi(req, res, path) {
  try {
    if (path === "/api/launch/config") return await cfg(req, res);
    if (path === "/api/launch/list") return await list(req, res);
    if (path === "/api/launch/feed") return await newCoinsFeed(req, res);
    if (path === "/api/launch/token") return await token(req, res);
    if (path === "/api/launch/meta") return await meta(req, res);
    if (path === "/api/launch/img") return await img(req, res);
    if (path === "/api/launch/quote") return await quote(req, res);
    if (path === "/api/launch/balance") return await balance(req, res);
    if (path === "/api/launch/prepare") return await prepare(req, res);
    if (path === "/api/launch/confirm") return await confirm(req, res);
    if (path === "/api/launch/swap") return await swap(req, res);
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    console.error("LAUNCH_ERROR", path, e && e.message);
    const m = String((e && e.message) || "");
    const hint = /launch_tokens/.test(m) ? "RUN_db_launchpad_sql_IN_NEON" : /Cannot find (module|package)/.test(m) ? "DEPENDENCIES_NOT_INSTALLED" : undefined;
    return send(res, 500, { ok: false, error: "LAUNCH_FAILED", hint });
  }
}
