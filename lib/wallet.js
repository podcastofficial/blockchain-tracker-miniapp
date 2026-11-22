// Custodial wallet service (Part 1): wallet creation, deposit addresses, asset list, balances, ledger.
//   GET  /api/wallet             -> { wallet | null }
//   POST /api/wallet/create      -> creates this user's wallet (idempotent)
//   GET  /api/wallet/addresses   -> deposit addresses per network (+ which chains/tokens each accepts)
//   GET  /api/wallet/assets      -> supported coins + limits
//   GET  /api/wallet/balances    -> balances for the Assets page (USD valued)
//   GET  /api/wallet/ledger?limit=&before=&asset=
// Deposit detection = Part 2, withdrawals = Part 3. All money moves go through postLedger() (atomic, idempotent, never negative).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { EVM, fetchPrices } from "./balances.js";
import { deriveAllAddresses, seedFingerprint, masterSeed } from "./hdwallet.js";
import { WALLET_SCHEMA_SQL } from "./wallet_schema.js";

const STABLE = new Set(["USDT", "USDC"]);
const A = (symbol, chain, network, kind, contract, decimals, o = {}) => ({
  symbol, chain, network, kind, contract: contract || null, decimals,
  min_deposit: o.minDep ?? (STABLE.has(symbol) ? 1 : 0.0001),
  min_withdraw: o.minWd ?? (STABLE.has(symbol) ? 10 : 0.001),
  withdraw_fee: o.fee ?? (STABLE.has(symbol) ? 1 : 0.0005),
  required_confirmations: o.conf ?? 12, sort_order: o.sort ?? 100
});
function defaultAssets() {
  const out = [];
  const conf = { ethereum: 12, bsc: 15, polygon: 64, arbitrum: 20, base: 20, optimism: 20, avalanche: 20 };
  let s = 0;
  for (const [chain, c] of Object.entries(EVM)) {
    out.push(A(c.symbol, chain, "evm", "native", null, 18, { conf: conf[chain], sort: ++s }));
    for (const t of c.tokens) out.push(A(t.symbol, chain, "evm", "token", t.address, t.decimals, { conf: conf[chain], sort: ++s }));
  }
  out.push(A("TRX", "tron", "tron", "native", null, 6, { conf: 19, minDep: 1, minWd: 10, fee: 1, sort: ++s }));
  out.push(A("USDT", "tron", "tron", "token", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 6, { conf: 19, fee: 1, sort: ++s }));
  out.push(A("SOL", "solana", "solana", "native", null, 9, { conf: 32, minDep: 0.001, minWd: 0.01, fee: 0.001, sort: ++s }));
  out.push(A("USDT", "solana", "solana", "token", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6, { conf: 32, fee: 1, sort: ++s }));
  out.push(A("USDC", "solana", "solana", "token", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6, { conf: 32, fee: 1, sort: ++s }));
  return out.map(a => ({ ...a, code: `${a.symbol}-${a.chain}`.toLowerCase() }));
}

let schemaP = null;
export function ensureWalletSchema() {
  if (!schemaP) schemaP = (async () => {
    const c = await db().connect();
    try {
      await c.query("SELECT pg_advisory_lock(7731001)");
      await c.query(WALLET_SCHEMA_SQL);
      for (const a of defaultAssets()) {
        await c.query(
          `INSERT INTO wallet_assets (code,symbol,chain,network,kind,contract,decimals,min_deposit,min_withdraw,withdraw_fee,required_confirmations,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (code) DO NOTHING`,
          [a.code, a.symbol, a.chain, a.network, a.kind, a.contract, a.decimals, a.min_deposit, a.min_withdraw, a.withdraw_fee, a.required_confirmations, a.sort_order]);
      }
    } finally {
      try { await c.query("SELECT pg_advisory_unlock(7731001)"); } catch { /* connection closes anyway */ }
      c.release();
    }
  })().catch(e => { schemaP = null; throw e; });
  return schemaP;
}

export async function withTx(fn) {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}

const NET_CHAINS = () => ({ evm: Object.keys(EVM), tron: ["tron"], solana: ["solana"] });

// Creates the wallet + all deposit addresses once per user. Safe under concurrent calls.
export async function ensureWallet(userId) {
  await ensureWalletSchema();
  const fp = seedFingerprint(masterSeed());
  const have = await db().query(`SELECT id, wallet_index, seed_fp, created_at FROM wallets WHERE user_id=$1`, [userId]);
  if (have.rowCount) {
    if (have.rows[0].seed_fp !== fp) throw new Error("WALLET_SEED_MISMATCH");
    return have.rows[0];
  }
  const u = await db().query(`SELECT is_blocked FROM users WHERE id=$1`, [userId]);
  if (!u.rowCount) throw new Error("USER_NOT_FOUND");
  if (u.rows[0].is_blocked) throw new Error("ACCOUNT_BLOCKED");
  return withTx(async c => {
    const ins = await c.query(
      `INSERT INTO wallets (user_id, seed_fp) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING RETURNING id, wallet_index, seed_fp, created_at`, [userId, fp]);
    if (!ins.rowCount) {
      const r = await c.query(`SELECT id, wallet_index, seed_fp, created_at FROM wallets WHERE user_id=$1`, [userId]);
      return r.rows[0];
    }
    const w = ins.rows[0];
    for (const a of deriveAllAddresses(w.wallet_index)) {
      await c.query(`INSERT INTO wallet_addresses (wallet_id,user_id,network,address,derivation_path) VALUES ($1,$2,$3,$4,$5)`,
        [w.id, userId, a.network, a.address, a.path]);
    }
    return w;
  });
}

// ---- ledger -------------------------------------------------------------------------------------------------------
const SIGNED = /^-?\d{1,20}(\.\d{1,18})?$/;
export const KINDS = ["deposit", "withdraw_lock", "withdraw_fee", "withdraw_complete", "withdraw_release", "adjustment",
  "trade_lock", "trade_release", "trade_buy", "trade_sell", "trade_fee", "futures_in", "futures_out"];
export const KINDS_SQL = KINDS.map(k => `'${k}'`).join(",");

// Atomic + idempotent balance change. deltaAvailable / deltaLocked are decimal STRINGS (never floats).
// Returns { duplicate:true } if (kind, refType, refId) was already booked. Throws INSUFFICIENT_BALANCE instead of going negative.
// Pass an existing transaction client to make it part of a bigger transaction (e.g. deposit row + credit).
export async function postLedger(client, { userId, assetId, kind, deltaAvailable = "0", deltaLocked = "0", refType = null, refId = null, note = null }) {
  if (!client) return withTx(c => postLedger(c, { userId, assetId, kind, deltaAvailable, deltaLocked, refType, refId, note }));
  if (!KINDS.includes(kind)) throw new Error("BAD_LEDGER_KIND");
  deltaAvailable = String(deltaAvailable); deltaLocked = String(deltaLocked);
  if (!SIGNED.test(deltaAvailable) || !SIGNED.test(deltaLocked)) throw new Error("BAD_AMOUNT");
  await client.query(`INSERT INTO user_balances (user_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, assetId]);
  await client.query(`SELECT 1 FROM user_balances WHERE user_id=$1 AND asset_id=$2 FOR UPDATE`, [userId, assetId]);
  const e = await client.query(
    `INSERT INTO ledger_entries (user_id,asset_id,kind,delta_available,delta_locked,available_after,locked_after,ref_type,ref_id,note)
     SELECT $1,$2,$3,$4::numeric,$5::numeric,b.available+$4::numeric,b.locked+$5::numeric,$6,$7,$8
       FROM user_balances b WHERE b.user_id=$1 AND b.asset_id=$2
     ON CONFLICT DO NOTHING RETURNING id, available_after, locked_after`,
    [userId, assetId, kind, deltaAvailable, deltaLocked, refType, refId == null ? null : String(refId), note]);
  if (!e.rowCount) return { duplicate: true };
  try {
    await client.query(`UPDATE user_balances SET available=available+$3::numeric, locked=locked+$4::numeric, updated_at=NOW() WHERE user_id=$1 AND asset_id=$2`,
      [userId, assetId, deltaAvailable, deltaLocked]);
  } catch (err) {
    if (err && err.code === "23514") throw new Error("INSUFFICIENT_BALANCE");
    throw err;
  }
  return { duplicate: false, ledgerId: e.rows[0].id, available: e.rows[0].available_after, locked: e.rows[0].locked_after };
}

// ---- API ----------------------------------------------------------------------------------------------------------
const num = v => Number(v);
const lim = (v, d, max) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);

async function addressesOf(userId) {
  const r = await db().query(`SELECT network, address, derivation_path FROM wallet_addresses WHERE user_id=$1 AND network IN ('evm','tron') ORDER BY network`, [userId]);
  return r.rows.map(x => ({ network: x.network, address: x.address, chains: x.network === 'evm' ? ['bsc'] : ['tron'] }));
}

async function balances(userId) {
  const r = await db().query(
    `SELECT a.id, a.code, a.symbol, a.chain, a.kind, a.contract, a.decimals, a.deposit_enabled, a.withdraw_enabled,
            COALESCE(b.available,0) AS available, COALESCE(b.locked,0) AS locked
       FROM wallet_assets a LEFT JOIN user_balances b ON b.asset_id=a.id AND b.user_id=$1
      ORDER BY a.sort_order, a.id`, [userId]);
  let prices = {}; try { prices = await fetchPrices(); } catch { /* unpriced */ }
  const price = s => STABLE.has(s) ? 1 : (prices[s]?.usd || 0);
  const rows = r.rows.map(x => {
    const total = num(x.available) + num(x.locked);
    return { code: x.code, symbol: x.symbol, chain: x.chain, kind: x.kind, contract: x.contract, decimals: x.decimals,
      available: x.available, locked: x.locked, usdPrice: price(x.symbol), usdValue: total * price(x.symbol),
      depositEnabled: x.deposit_enabled, withdrawEnabled: x.withdraw_enabled };
  });
  // Assets page: one line per coin symbol (summed across chains) + per-chain breakdown.
  const bySym = new Map();
  for (const x of rows) {
    const g = bySym.get(x.symbol) || { symbol: x.symbol, available: 0, locked: 0, usdValue: 0, usdPrice: x.usdPrice, chains: [] };
    g.available += num(x.available); g.locked += num(x.locked); g.usdValue += x.usdValue; g.chains.push(x);
    bySym.set(x.symbol, g);
  }
  const coins = [...bySym.values()].sort((a, b) => b.usdValue - a.usdValue);
  return { totalUsd: rows.reduce((s, x) => s + x.usdValue, 0), coins, assets: rows };
}

export async function walletApi(req, res, path) {
  try {
    const s = readSession(req);
    if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
    if (rateLimited(req, res, "wallet", s.id, 60)) return;
    const url = new URL(req.url, "https://x.invalid");

    if (path === "/api/wallet/create") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const w = await ensureWallet(s.id);
      return send(res, 200, { ok: true, wallet: { id: Number(w.id), createdAt: w.created_at }, addresses: await addressesOf(s.id) });
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    if (path === "/api/wallet") {
      await ensureWalletSchema();
      const r = await db().query(`SELECT id, created_at FROM wallets WHERE user_id=$1`, [s.id]);
      return send(res, 200, { ok: true, wallet: r.rowCount ? { id: Number(r.rows[0].id), createdAt: r.rows[0].created_at } : null });
    }
    if (path === "/api/wallet/addresses") {
      await ensureWallet(s.id);
      return send(res, 200, { ok: true, addresses: await addressesOf(s.id) });
    }
    if (path === "/api/wallet/assets") {
      await ensureWalletSchema();
      const r = await db().query(`SELECT code,symbol,chain,kind,contract,decimals,min_deposit,min_withdraw,withdraw_fee,required_confirmations,deposit_enabled,withdraw_enabled FROM wallet_assets ORDER BY sort_order,id`);
      return send(res, 200, { ok: true, assets: r.rows });
    }
    if (path === "/api/wallet/balances") {
      await ensureWallet(s.id);
      return send(res, 200, { ok: true, ...(await balances(s.id)), updatedAt: new Date().toISOString() });
    }
    if (path === "/api/wallet/ledger") {
      await ensureWalletSchema();
      const limit = lim(url.searchParams.get("limit"), 30, 100);
      const before = parseInt(url.searchParams.get("before"), 10) || null;
      const asset = String(url.searchParams.get("asset") || "").toLowerCase().replace(/[^a-z0-9-]/g, "") || null;
      const r = await db().query(
        `SELECT l.id, l.kind, a.code AS asset, a.symbol, a.chain, l.delta_available, l.delta_locked, l.available_after, l.ref_type, l.ref_id, l.created_at
           FROM ledger_entries l JOIN wallet_assets a ON a.id=l.asset_id
          WHERE l.user_id=$1 AND ($2::bigint IS NULL OR l.id<$2) AND ($3::text IS NULL OR a.code=$3)
          ORDER BY l.id DESC LIMIT $4`, [s.id, before, asset, limit]);
      return send(res, 200, { ok: true, entries: r.rows, next: r.rowCount === limit ? r.rows[r.rowCount - 1].id : null });
    }
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    const known = ["WALLET_MASTER_SEED_NOT_CONFIGURED", "WALLET_MASTER_SEED_INVALID", "WALLET_SEED_MISMATCH", "ACCOUNT_BLOCKED", "USER_NOT_FOUND"];
    console.error("WALLET_ERROR", path, e && e.message);
    if (e && e.message === "ACCOUNT_BLOCKED") return send(res, 403, { ok: false, error: "ACCOUNT_BLOCKED" });
    return send(res, 500, { ok: false, error: known.includes(e && e.message) ? "WALLET_NOT_AVAILABLE" : "WALLET_FAILED" });
  }
}
