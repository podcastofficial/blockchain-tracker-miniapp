// Internal custodial USDT-margined perpetual futures (one-way mode, isolated margin).
//
// The platform is the counterparty: there is no order book. Fills are priced off the exchange mark price
// (Binance USDT-M futures, with fallbacks), so liquidity is unlimited but the platform carries the risk.
// Hence the conservative defaults below and the FUTURES_ENABLED=0 kill switch.
//
//   GET  /api/futures/markets                 public  markets + mark prices + limits
//   GET  /api/futures/account                 auth    balance, margin, uPnL, positions
//   GET  /api/futures/orders?status=open|history      auth
//   GET  /api/futures/trades                          auth
//   POST /api/futures/transfer  {direction:in|out, asset:"usdt-bsc", amount}   spot wallet <-> futures account
//   POST /api/futures/order     {symbol, side:buy|sell, type:market|limit, quantity, price?, leverage}
//   POST /api/futures/cancel    {orderId}
//   POST /api/futures/close     {symbol}      market-close the whole position
//   GET  /api/cron/futures                    worker: fills limit orders + liquidates (CRON_SECRET)
//
// Money is BigInt with 18 decimals (same scheme as lib/trading.js); balances never go negative (CHECK constraints).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited, clientKey } from "./ratelimit.js";
import { ensureWallet, ensureWalletSchema, withTx, postLedger, KINDS_SQL } from "./wallet.js";
import crypto from "node:crypto";

const S = 10n ** 18n;
const NUM_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/;
const toU = v => {
  const s = String(v ?? "").trim();
  if (!NUM_RE.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * S + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const fmt = n => {
  const neg = n < 0n ? "-" : "";
  if (n < 0n) n = -n;
  const frac = (n % S).toString().padStart(18, "0").replace(/0+$/, "");
  return neg + (n / S).toString() + (frac ? "." + frac : "");
};
const mul = (a, b) => (a * b) / S;
const div = (a, b) => (a * S) / b;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const minB = (a, b) => (a < b ? a : b);
const maxB = (a, b) => (a > b ? a : b);
const clean = v => String(v ?? "").trim();
const decimalsOf = v => (String(v).split(".")[1] || "").length;

const intEnv = (name, def, lo, hi) => {
  const n = Number(process.env[name] ?? def);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};
export function futuresConfig() {
  const mmrBps = intEnv("FUTURES_MAINT_MARGIN_BPS", 50, 10, 400);
  const maxLev = Math.min(intEnv("FUTURES_MAX_LEVERAGE", 20, 1, 50), Math.floor(5000 / mmrBps)); // keep 1/lev >= 2*mmr
  const cap = Number(process.env.FUTURES_MAX_POSITION_USDT ?? 5000);
  return {
    enabled: !["0", "false", "off"].includes(String(process.env.FUTURES_ENABLED ?? "1").toLowerCase()),
    feeBps: intEnv("FUTURES_TAKER_FEE_BPS", 5, 0, 200),
    slipBps: intEnv("FUTURES_SLIPPAGE_BPS", 5, 0, 200),
    mmrBps, maxLev,
    maxNotional: toU(String(Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 5000)),
    minNotional: 5n * S
  };
}

// [base asset, quantity decimals]. Symbols are Binance USDT-M perpetual names (BTC -> BTCUSDT).
const SEED = [["BTC", 3], ["ETH", 3], ["BNB", 2], ["SOL", 2], ["XRP", 1], ["DOGE", 0], ["TRX", 0], ["ADA", 0], ["AVAX", 2], ["LINK", 2]];

// ---- schema -------------------------------------------------------------------------------------------------------
let schemaP;
async function ensureSchema() {
  await ensureWalletSchema();
  if (!schemaP) schemaP = (async () => {
    const c = await db().connect();
    try {
      await c.query("SELECT pg_advisory_lock(7731003)");
      await c.query(`
        ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_kind_check;
        ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN (${KINDS_SQL}));
        CREATE TABLE IF NOT EXISTS futures_markets (
          id BIGSERIAL PRIMARY KEY,
          symbol TEXT NOT NULL UNIQUE,
          base TEXT NOT NULL,
          qty_decimals INTEGER NOT NULL DEFAULT 3,
          is_active BOOLEAN NOT NULL DEFAULT TRUE
        );
        CREATE TABLE IF NOT EXISTS futures_accounts (
          user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          balance NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS futures_positions (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          market_id BIGINT NOT NULL REFERENCES futures_markets(id),
          side TEXT NOT NULL CHECK (side IN ('long','short')),
          quantity NUMERIC(38,18) NOT NULL CHECK (quantity > 0),
          entry_price NUMERIC(38,18) NOT NULL CHECK (entry_price > 0),
          leverage INTEGER NOT NULL CHECK (leverage BETWEEN 1 AND 50),
          margin NUMERIC(38,18) NOT NULL CHECK (margin > 0),
          liq_price NUMERIC(38,18) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, market_id)
        );
        CREATE TABLE IF NOT EXISTS futures_orders (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          market_id BIGINT NOT NULL REFERENCES futures_markets(id),
          side TEXT NOT NULL CHECK (side IN ('buy','sell')),
          order_type TEXT NOT NULL CHECK (order_type IN ('market','limit')),
          kind TEXT NOT NULL CHECK (kind IN ('open','reduce')),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
          quantity NUMERIC(38,18) NOT NULL CHECK (quantity > 0),
          filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,
          limit_price NUMERIC(38,18),
          fill_price NUMERIC(38,18),
          leverage INTEGER NOT NULL DEFAULT 1,
          reserved NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
          note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fut_orders_open ON futures_orders(status, market_id) WHERE status='open';
        CREATE INDEX IF NOT EXISTS idx_fut_orders_user ON futures_orders(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS futures_trades (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          market_id BIGINT NOT NULL REFERENCES futures_markets(id),
          order_id BIGINT REFERENCES futures_orders(id),
          side TEXT NOT NULL CHECK (side IN ('buy','sell')),
          kind TEXT NOT NULL CHECK (kind IN ('open','close','liquidation')),
          quantity NUMERIC(38,18) NOT NULL,
          price NUMERIC(38,18) NOT NULL,
          fee NUMERIC(38,18) NOT NULL DEFAULT 0,
          realized_pnl NUMERIC(38,18) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fut_trades_user ON futures_trades(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS futures_transfers (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          direction TEXT NOT NULL CHECK (direction IN ('in','out')),
          asset_code TEXT NOT NULL,
          amount NUMERIC(38,18) NOT NULL CHECK (amount > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fut_transfers_user ON futures_transfers(user_id, id DESC);
      `);
      for (const [base, dp] of SEED) {
        await c.query(`INSERT INTO futures_markets(symbol,base,qty_decimals) VALUES($1,$2,$3) ON CONFLICT (symbol) DO NOTHING`, [base + "USDT", base, dp]);
      }
    } finally {
      try { await c.query("SELECT pg_advisory_unlock(7731003)"); } catch { /* connection closes anyway */ }
      c.release();
    }
  })().catch(e => { schemaP = null; throw e; });
  return schemaP;
}

// ---- mark prices --------------------------------------------------------------------------------------------------
const MARK_FRESH_MS = 2000;      // reuse cache this long
const MARK_MAX_AGE_MS = 10000;   // never fill/liquidate on a price older than this
let priceCache = { ts: 0, map: new Map(), source: null };
let priceInflight = null;
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const normPrice = p => {
  const s = String(p);
  if (NUM_RE.test(s) && toU(s) > 0n) return s;
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n.toFixed(8) : null;
};
async function fetchMarks(symbols) {
  const want = new Set(symbols);
  const sources = [
    ["binance-futures", async () => (await getJson("https://fapi.binance.com/fapi/v1/premiumIndex")).map(x => [x.symbol, x.markPrice])],
    ["okx-swap", async () => ((await getJson("https://www.okx.com/api/v5/public/mark-price?instType=SWAP")).data || [])
      .filter(x => /-USDT-SWAP$/.test(x.instId)).map(x => [x.instId.replace("-USDT-SWAP", "USDT"), x.markPx])],
    ["binance-spot", async () => (await getJson("https://data-api.binance.vision/api/v3/ticker/price")).map(x => [x.symbol, x.price])]
  ];
  for (const [name, load] of sources) {
    try {
      const m = new Map();
      for (const [sym, px] of await load()) {
        if (!want.has(sym)) continue;
        const v = normPrice(px);
        if (v) m.set(sym, v);
      }
      if (m.size >= Math.ceil(want.size / 2)) return { map: m, source: name };
    } catch { /* try next source */ }
  }
  throw new Error("PRICE_UNAVAILABLE");
}
// Returns Map(symbol -> price string). Throws PRICE_UNAVAILABLE if nothing fresh enough could be loaded.
async function getMarks(maxAge = MARK_MAX_AGE_MS) {
  const age = Date.now() - priceCache.ts;
  if (age < MARK_FRESH_MS && priceCache.map.size) return priceCache;
  if (!priceInflight) {
    priceInflight = fetchMarks(SEED.map(x => x[0] + "USDT"))
      .then(r => { priceCache = { ts: Date.now(), map: r.map, source: r.source }; return priceCache; })
      .finally(() => { priceInflight = null; });
  }
  try { return await priceInflight; }
  catch (e) {
    if (priceCache.map.size && Date.now() - priceCache.ts <= maxAge) return priceCache;
    throw e;
  }
}

// ---- helpers ------------------------------------------------------------------------------------------------------
const mmr = cf => (BigInt(cf.mmrBps) * S) / 10000n;
// Isolated liquidation price: margin + pnl = maintenance_rate * notional_at_liq.
function liqPrice(side, entry, qty, margin, cf) {
  const r = mmr(cf);
  if (side === "long") {
    const num = mul(entry, qty) - margin;
    return num <= 0n ? 0n : div(num, mul(qty, S - r));
  }
  return div(mul(entry, qty) + margin, mul(qty, S + r));
}
const pnlOf = (side, entry, price, qty) => mul(side === "long" ? price - entry : entry - price, qty);

async function marketBySymbol(sym) {
  const r = await db().query(`SELECT * FROM futures_markets WHERE symbol=$1 AND is_active=TRUE`, [sym]);
  return r.rows[0] || null;
}
async function lockAccount(c, userId) {
  await c.query(`INSERT INTO futures_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [userId]);
  const r = await c.query(`SELECT balance::text AS b FROM futures_accounts WHERE user_id=$1 FOR UPDATE`, [userId]);
  return toU(r.rows[0].b);
}
async function setBalance(c, userId, bal) {
  try {
    await c.query(`UPDATE futures_accounts SET balance=$2::numeric, updated_at=NOW() WHERE user_id=$1`, [userId, fmt(bal)]);
  } catch (e) {
    if (e && e.code === "23514") throw new Error("INSUFFICIENT_MARGIN");
    throw e;
  }
}
// Everything already earmarked: position margins + reserves of open limit orders (optionally excluding one order).
async function committed(c, userId, exceptOrderId = null) {
  const [p, o] = await Promise.all([
    c.query(`SELECT COALESCE(SUM(margin),0)::text AS v FROM futures_positions WHERE user_id=$1`, [userId]),
    c.query(`SELECT COALESCE(SUM(reserved),0)::text AS v FROM futures_orders WHERE user_id=$1 AND status='open' AND ($2::bigint IS NULL OR id<>$2)`, [userId, exceptOrderId])
  ]);
  return toU(p.rows[0].v) + toU(o.rows[0].v);
}
async function assertNotBlocked(c, userId) {
  const u = await c.query(`SELECT is_blocked FROM users WHERE id=$1`, [userId]);
  if (!u.rowCount || u.rows[0].is_blocked) throw new Error("ACCOUNT_BLOCKED");
}

// Applies one fill to the account/position. kind 'open' = open or add (same side), 'reduce' = reduce/close (opposite side).
async function settleFill(c, cf, { userId, mkt, side, qty, price, lev, orderId, kind }) {
  let bal = await lockAccount(c, userId);
  const pr = await c.query(`SELECT * FROM futures_positions WHERE user_id=$1 AND market_id=$2 FOR UPDATE`, [userId, mkt.id]);
  const pos = pr.rows[0] || null;
  const feeRate = BigInt(cf.feeBps);

  if (kind === "open") {
    const posSide = side === "buy" ? "long" : "short";
    if (pos && pos.side !== posSide) throw new Error("POSITION_CONFLICT");
    const L = BigInt(pos ? pos.leverage : lev);
    const notional = mul(price, qty);
    if (notional < cf.minNotional) throw new Error("ORDER_TOO_SMALL");
    const fee = (notional * feeRate) / 10000n;
    const marginAdd = ceilDiv(notional, L);
    const oldQ = pos ? toU(pos.quantity) : 0n, oldE = pos ? toU(pos.entry_price) : 0n, oldM = pos ? toU(pos.margin) : 0n;
    const newQ = oldQ + qty;
    const newE = pos ? div(mul(oldQ, oldE) + mul(qty, price), newQ) : price;
    const newM = oldM + marginAdd;
    if (mul(newQ, newE) > cf.maxNotional) throw new Error("MAX_POSITION_EXCEEDED");
    const others = await committed(c, userId, orderId);
    if (bal - others < marginAdd + fee) throw new Error("INSUFFICIENT_MARGIN");
    const liq = liqPrice(posSide, newE, newQ, newM, cf);
    await setBalance(c, userId, bal - fee);
    await c.query(
      `INSERT INTO futures_positions(user_id,market_id,side,quantity,entry_price,leverage,margin,liq_price)
       VALUES($1,$2,$3,$4::numeric,$5::numeric,$6,$7::numeric,$8::numeric)
       ON CONFLICT (user_id,market_id) DO UPDATE SET quantity=EXCLUDED.quantity, entry_price=EXCLUDED.entry_price,
         margin=EXCLUDED.margin, liq_price=EXCLUDED.liq_price, updated_at=NOW()`,
      [userId, mkt.id, posSide, fmt(newQ), fmt(newE), Number(L), fmt(newM), fmt(liq)]);
    await c.query(
      `INSERT INTO futures_trades(user_id,market_id,order_id,side,kind,quantity,price,fee,realized_pnl) VALUES($1,$2,$3,$4,'open',$5::numeric,$6::numeric,$7::numeric,0)`,
      [userId, mkt.id, orderId, side, fmt(qty), fmt(price), fmt(fee)]);
    return { filled: qty, realized: 0n, fee };
  }

  // reduce / close
  const posSide = side === "sell" ? "long" : "short";
  if (!pos || pos.side !== posSide) throw new Error("NO_POSITION_TO_REDUCE");
  const posQ = toU(pos.quantity), entry = toU(pos.entry_price), m = toU(pos.margin);
  const q = minB(qty, posQ);
  const marginRel = q === posQ ? m : (m * q) / posQ;
  const pnl = maxB(pnlOf(pos.side, entry, price, q), -marginRel); // isolated: a position can never lose more than its margin
  const fee = minB((mul(price, q) * feeRate) / 10000n, maxB(0n, bal + pnl));
  await setBalance(c, userId, bal + pnl - fee);
  if (q === posQ) {
    await c.query(`DELETE FROM futures_positions WHERE id=$1`, [pos.id]);
  } else {
    const rq = posQ - q, rm = m - marginRel;
    await c.query(`UPDATE futures_positions SET quantity=$2::numeric, margin=$3::numeric, liq_price=$4::numeric, updated_at=NOW() WHERE id=$1`,
      [pos.id, fmt(rq), fmt(rm), fmt(liqPrice(pos.side, entry, rq, rm, cf))]);
  }
  await c.query(
    `INSERT INTO futures_trades(user_id,market_id,order_id,side,kind,quantity,price,fee,realized_pnl) VALUES($1,$2,$3,$4,'close',$5::numeric,$6::numeric,$7::numeric,$8::numeric)`,
    [userId, mkt.id, orderId, side, fmt(q), fmt(price), fmt(fee), fmt(pnl - fee)]);
  return { filled: q, realized: pnl - fee, fee };
}

const slip = (mark, side, cf) => {
  const m = toU(mark), b = BigInt(cf.slipBps);
  return side === "buy" ? (m * (10000n + b)) / 10000n : (m * (10000n - b)) / 10000n;
};
// A limit order that is already marketable fills at the mark (never worse for the user than their limit).
const marketable = (side, limit, mark) => (side === "buy" ? mark <= limit : mark >= limit);
const limitFillPrice = (side, limit, mark) => (side === "buy" ? minB(limit, mark) : maxB(limit, mark));

const orderView = r => ({
  id: Number(r.id), symbol: r.symbol, side: r.side, type: r.order_type, kind: r.kind, status: r.status,
  quantity: String(r.quantity), filledQuantity: String(r.filled_quantity),
  price: r.limit_price == null ? null : String(r.limit_price), fillPrice: r.fill_price == null ? null : String(r.fill_price),
  leverage: Number(r.leverage), reserved: String(r.reserved), note: r.note || null, createdAt: r.created_at
});

// ---- order placement ----------------------------------------------------------------------------------------------
async function placeOrder(userId, body, { internal = false } = {}) {
  const cf = futuresConfig();
  const symbol = clean(body.symbol).toUpperCase(), side = clean(body.side).toLowerCase(), type = clean(body.type).toLowerCase();
  const lev = Number(body.leverage ?? 1);
  const qty = toU(body.quantity), limit = type === "limit" ? toU(body.price) : null;
  if (!/^[A-Z0-9]{5,15}$/.test(symbol) || !["buy", "sell"].includes(side) || !["market", "limit"].includes(type)
      || qty === null || qty <= 0n || (type === "limit" && (!limit || limit <= 0n))) throw new Error("INVALID_ORDER");
  if (!Number.isInteger(lev) || lev < 1 || lev > cf.maxLev) throw new Error("INVALID_LEVERAGE");
  const mkt = await marketBySymbol(symbol);
  if (!mkt) throw new Error("MARKET_NOT_FOUND");
  if (!internal && (decimalsOf(body.quantity) > mkt.qty_decimals)) throw new Error("INVALID_ORDER_PRECISION");
  if (type === "limit" && decimalsOf(body.price) > 8) throw new Error("INVALID_ORDER_PRECISION");
  const marks = await getMarks();
  const markStr = marks.map.get(symbol);
  if (!markStr) throw new Error("PRICE_UNAVAILABLE");
  const mark = toU(markStr);
  if (type === "limit" && (limit > mark * 3n || limit < mark / 3n)) throw new Error("PRICE_OUT_OF_RANGE");

  return withTx(async c => {
    await assertNotBlocked(c, userId);
    const bal = await lockAccount(c, userId);
    const pr = await c.query(`SELECT side,quantity::text AS q,leverage FROM futures_positions WHERE user_id=$1 AND market_id=$2`, [userId, mkt.id]);
    const pos = pr.rows[0] || null;
    const wantPos = side === "buy" ? "long" : "short";
    const kind = pos && pos.side !== wantPos ? "reduce" : "open";
    const useLev = kind === "open" && pos ? Number(pos.leverage) : lev;
    if (kind === "reduce" && qty > toU(pos.q)) throw new Error("REDUCE_EXCEEDS_POSITION");

    const ins = await c.query(
      `INSERT INTO futures_orders(user_id,market_id,side,order_type,kind,quantity,limit_price,leverage)
       VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8) RETURNING *`,
      [userId, mkt.id, side, type, kind, fmt(qty), limit === null ? null : fmt(limit), useLev]);
    const order = ins.rows[0];
    const row = extra => orderView({ ...order, ...extra, symbol });

    let fillPrice = null;
    if (type === "market") fillPrice = slip(markStr, side, cf);
    else if (marketable(side, limit, mark)) fillPrice = limitFillPrice(side, limit, mark);

    if (fillPrice !== null) {
      const res = await settleFill(c, cf, { userId, mkt, side, qty, price: fillPrice, lev: useLev, orderId: order.id, kind });
      const up = await c.query(
        `UPDATE futures_orders SET status='filled', filled_quantity=$2::numeric, fill_price=$3::numeric, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [order.id, fmt(res.filled), fmt(fillPrice)]);
      return { order: orderView({ ...up.rows[0], symbol }), filledQuantity: fmt(res.filled), price: fmt(fillPrice), realizedPnl: fmt(res.realized) };
    }

    // resting limit order: earmark margin + fee so the funds cannot be spent twice
    let reserved = 0n;
    if (kind === "open") {
      const notional = mul(limit, qty);
      if (notional < cf.minNotional) throw new Error("ORDER_TOO_SMALL");
      reserved = ceilDiv(notional, BigInt(useLev)) + (notional * BigInt(cf.feeBps)) / 10000n;
      if (bal - (await committed(c, userId, order.id)) < reserved) throw new Error("INSUFFICIENT_MARGIN");
      await c.query(`UPDATE futures_orders SET reserved=$2::numeric WHERE id=$1`, [order.id, fmt(reserved)]);
    }
    return { order: row({ reserved: fmt(reserved) }), filledQuantity: "0", price: null, realizedPnl: "0" };
  });
}

async function cancelOrder(userId, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("INVALID_ORDER_ID");
  return withTx(async c => {
    const q = await c.query(`SELECT id,status FROM futures_orders WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    if (!q.rowCount) throw new Error("ORDER_NOT_FOUND");
    if (q.rows[0].status !== "open") throw new Error("ORDER_NOT_OPEN");
    await c.query(`UPDATE futures_orders SET status='cancelled', reserved=0, updated_at=NOW() WHERE id=$1`, [id]);
    return { id, status: "cancelled" };
  });
}

async function closePosition(userId, symbol) {
  symbol = clean(symbol).toUpperCase();
  const mkt = await marketBySymbol(symbol);
  if (!mkt) throw new Error("MARKET_NOT_FOUND");
  const r = await db().query(`SELECT side,quantity::text AS q FROM futures_positions WHERE user_id=$1 AND market_id=$2`, [userId, mkt.id]);
  if (!r.rowCount) throw new Error("NO_POSITION_TO_REDUCE");
  // also drop this user's resting reduce orders so nothing can re-open or double-close later
  await db().query(`UPDATE futures_orders SET status='cancelled', reserved=0, updated_at=NOW() WHERE user_id=$1 AND market_id=$2 AND status='open' AND kind='reduce'`, [userId, mkt.id]);
  return placeOrder(userId, { symbol, side: r.rows[0].side === "long" ? "sell" : "buy", type: "market", quantity: r.rows[0].q, leverage: 1 }, { internal: true });
}

// ---- transfers (spot wallet <-> futures account) ------------------------------------------------------------------
async function transfer(userId, body) {
  const direction = clean(body.direction).toLowerCase();
  const code = clean(body.asset).toLowerCase();
  const amt = toU(body.amount);
  if (!["in", "out"].includes(direction) || amt === null || amt <= 0n || decimalsOf(body.amount) > 6 || !/^[a-z0-9-]{3,30}$/.test(code)) throw new Error("INVALID_TRANSFER");
  if (amt < S) throw new Error("TRANSFER_TOO_SMALL");
  const a = await db().query(`SELECT id FROM wallet_assets WHERE code=$1 AND symbol='USDT'`, [code]);
  if (!a.rowCount) throw new Error("ASSET_NOT_SUPPORTED");
  const assetId = Number(a.rows[0].id);
  return withTx(async c => {
    await assertNotBlocked(c, userId);
    const bal = await lockAccount(c, userId);
    const ref = crypto.randomUUID();
    if (direction === "in") {
      await postLedger(c, { userId, assetId, kind: "futures_in", deltaAvailable: fmt(-amt), refType: "futures_transfer", refId: ref, note: "Transfer to futures account" });
      await setBalance(c, userId, bal + amt);
    } else {
      const free = bal - (await committed(c, userId));
      if (free < amt) throw new Error("INSUFFICIENT_MARGIN");
      await setBalance(c, userId, bal - amt);
      await postLedger(c, { userId, assetId, kind: "futures_out", deltaAvailable: fmt(amt), refType: "futures_transfer", refId: ref, note: "Transfer from futures account" });
    }
    await c.query(`INSERT INTO futures_transfers(user_id,direction,asset_code,amount) VALUES($1,$2,$3,$4::numeric)`, [userId, direction, code, fmt(amt)]);
    return { direction, asset: code, amount: fmt(amt) };
  });
}

// ---- views --------------------------------------------------------------------------------------------------------
async function accountView(userId) {
  const cf = futuresConfig();
  let marks = null; try { marks = await getMarks(60000); } catch { /* show without uPnL */ }
  const [acc, pos, ord] = await Promise.all([
    db().query(`SELECT balance::text AS b FROM futures_accounts WHERE user_id=$1`, [userId]),
    db().query(`SELECT p.*, m.symbol, m.base FROM futures_positions p JOIN futures_markets m ON m.id=p.market_id WHERE p.user_id=$1 ORDER BY p.id`, [userId]),
    db().query(`SELECT COALESCE(SUM(reserved),0)::text AS v FROM futures_orders WHERE user_id=$1 AND status='open'`, [userId])
  ]);
  const bal = acc.rowCount ? toU(acc.rows[0].b) : 0n;
  let posMargin = 0n, upnl = 0n;
  const positions = pos.rows.map(p => {
    const q = toU(p.quantity), e = toU(p.entry_price), m = toU(p.margin);
    const markStr = marks?.map.get(p.symbol), mark = markStr ? toU(markStr) : null;
    const pnl = mark ? pnlOf(p.side, e, mark, q) : null;
    posMargin += m; if (pnl !== null) upnl += maxB(pnl, -m);
    return {
      symbol: p.symbol, base: p.base, side: p.side, quantity: String(p.quantity), entryPrice: String(p.entry_price), leverage: Number(p.leverage),
      margin: String(p.margin), liqPrice: String(p.liq_price), markPrice: markStr || null,
      unrealizedPnl: pnl === null ? null : fmt(maxB(pnl, -m)), roePct: pnl === null || m === 0n ? null : Number(maxB(pnl, -m) * 10000n / m) / 100,
      notional: mark ? fmt(mul(mark, q)) : null
    };
  });
  const ordRes = toU(ord.rows[0].v);
  return {
    balance: fmt(bal), positionMargin: fmt(posMargin), orderMargin: fmt(ordRes), available: fmt(maxB(0n, bal - posMargin - ordRes)),
    unrealizedPnl: fmt(upnl), equity: fmt(bal + upnl), positions,
    limits: { maxLeverage: cf.maxLev, maxPositionUsdt: fmt(cf.maxNotional), minOrderUsdt: fmt(cf.minNotional), feeBps: cf.feeBps, maintenanceBps: cf.mmrBps }
  };
}

async function listMarkets() {
  const cf = futuresConfig();
  const r = await db().query(`SELECT id,symbol,base,qty_decimals FROM futures_markets WHERE is_active=TRUE ORDER BY id`);
  let marks = null; try { marks = await getMarks(60000); } catch { /* prices unavailable */ }
  return {
    ok: true, priceSource: marks?.source || null, priceAgeMs: marks ? Date.now() - marks.ts : null,
    limits: { maxLeverage: cf.maxLev, maxPositionUsdt: fmt(cf.maxNotional), minOrderUsdt: fmt(cf.minNotional), feeBps: cf.feeBps, slippageBps: cf.slipBps, maintenanceBps: cf.mmrBps },
    markets: r.rows.map(m => ({ id: Number(m.id), symbol: m.symbol, base: m.base, quote: "USDT", qtyDecimals: m.qty_decimals, markPrice: marks?.map.get(m.symbol) || null }))
  };
}

// ---- worker: liquidations + resting limit orders ------------------------------------------------------------------
let lastSweep = 0;
export async function sweep() {
  const cf = futuresConfig();
  if (!cf.enabled) return { skipped: "disabled" };
  await ensureSchema();
  const lock = await db().connect();
  try {
    const got = await lock.query(`SELECT pg_try_advisory_lock(7731004) AS ok`);
    if (!got.rows[0].ok) return { skipped: "busy" };
    let marks;
    try { marks = await getMarks(); } catch { return { skipped: "no_price" }; }
    const out = { liquidated: 0, filled: 0, cancelled: 0 };

    const ps = await db().query(`SELECT p.id,p.user_id,p.market_id,m.symbol FROM futures_positions p JOIN futures_markets m ON m.id=p.market_id ORDER BY p.id LIMIT 500`);
    for (const p of ps.rows) {
      const markStr = marks.map.get(p.symbol); if (!markStr) continue;
      const mark = toU(markStr);
      try {
        const done = await withTx(async c => {
          await lockAccount(c, p.user_id);
          const r = await c.query(`SELECT * FROM futures_positions WHERE id=$1 FOR UPDATE`, [p.id]);
          const pos = r.rows[0]; if (!pos) return false;
          const liq = toU(pos.liq_price);
          const hit = pos.side === "long" ? mark <= liq : mark >= liq;
          if (!hit) return false;
          const m = toU(pos.margin), q = toU(pos.quantity);
          const bal = await lockAccount(c, pos.user_id);
          const loss = minB(m, bal);
          await setBalance(c, pos.user_id, bal - loss);
          await c.query(`DELETE FROM futures_positions WHERE id=$1`, [pos.id]);
          await c.query(`UPDATE futures_orders SET status='cancelled', reserved=0, note='position liquidated', updated_at=NOW() WHERE user_id=$1 AND market_id=$2 AND status='open' AND kind='reduce'`, [pos.user_id, pos.market_id]);
          await c.query(
            `INSERT INTO futures_trades(user_id,market_id,side,kind,quantity,price,fee,realized_pnl) VALUES($1,$2,$3,'liquidation',$4::numeric,$5::numeric,0,$6::numeric)`,
            [pos.user_id, pos.market_id, pos.side === "long" ? "sell" : "buy", fmt(q), fmt(mark), fmt(-loss)]);
          return true;
        });
        if (done) out.liquidated++;
      } catch (e) { console.error("FUTURES_LIQ_ERROR", p.id, e && e.message); }
    }

    const os = await db().query(
      `SELECT o.id,o.user_id,o.market_id,o.side,o.limit_price::text AS lp,m.symbol FROM futures_orders o JOIN futures_markets m ON m.id=o.market_id
        WHERE o.status='open' AND o.order_type='limit' ORDER BY o.id LIMIT 500`);
    for (const o of os.rows) {
      const markStr = marks.map.get(o.symbol); if (!markStr) continue;
      const mark = toU(markStr), limit = toU(o.lp);
      if (!marketable(o.side, limit, mark)) continue;
      try {
        await withTx(async c => {
          await lockAccount(c, o.user_id);
          const r = await c.query(`SELECT * FROM futures_orders WHERE id=$1 FOR UPDATE`, [o.id]);
          const ord = r.rows[0]; if (!ord || ord.status !== "open") return;
          await assertNotBlocked(c, ord.user_id);
          const mkt = (await c.query(`SELECT * FROM futures_markets WHERE id=$1`, [ord.market_id])).rows[0];
          const price = limitFillPrice(ord.side, limit, mark), qty = toU(ord.quantity);
          await c.query(`UPDATE futures_orders SET reserved=0 WHERE id=$1`, [ord.id]);
          const res = await settleFill(c, cf, { userId: Number(ord.user_id), mkt, side: ord.side, qty, price, lev: Number(ord.leverage), orderId: ord.id, kind: ord.kind });
          await c.query(`UPDATE futures_orders SET status='filled', filled_quantity=$2::numeric, fill_price=$3::numeric, updated_at=NOW() WHERE id=$1`, [ord.id, fmt(res.filled), fmt(price)]);
        });
        out.filled++;
      } catch (e) {
        // order can no longer be executed (margin spent, position changed...) -> cancel it and release its reserve
        try {
          await db().query(`UPDATE futures_orders SET status='cancelled', reserved=0, note=$2, updated_at=NOW() WHERE id=$1 AND status='open'`, [o.id, String(e && e.message || "FAILED").slice(0, 60)]);
          out.cancelled++;
        } catch { /* next sweep retries */ }
      }
    }
    return out;
  } finally {
    try { await lock.query(`SELECT pg_advisory_unlock(7731004)`); } catch { /* ignore */ }
    lock.release();
  }
}
// Opportunistic sweep so liquidations/fills don't wait for the cron: at most once per 4 s per server instance.
async function lazySweep() {
  if (Date.now() - lastSweep < 4000) return;
  lastSweep = Date.now();
  try { await sweep(); } catch (e) { console.error("FUTURES_SWEEP_ERROR", e && e.message); }
}

// ---- router -------------------------------------------------------------------------------------------------------
const BAD_REQUEST = new Set(["INVALID_ORDER", "INVALID_ORDER_PRECISION", "INVALID_LEVERAGE", "INVALID_ORDER_ID", "MARKET_NOT_FOUND", "ORDER_NOT_FOUND",
  "ORDER_NOT_OPEN", "ACCOUNT_BLOCKED", "ORDER_TOO_SMALL", "REDUCE_EXCEEDS_POSITION", "NO_POSITION_TO_REDUCE", "PRICE_OUT_OF_RANGE",
  "INVALID_TRANSFER", "TRANSFER_TOO_SMALL", "ASSET_NOT_SUPPORTED"]);
const CONFLICT = new Set(["INSUFFICIENT_MARGIN", "INSUFFICIENT_BALANCE", "MAX_POSITION_EXCEEDED", "POSITION_CONFLICT"]);

export async function futuresApi(req, res, path) {
  try {
    if (!futuresConfig().enabled) return send(res, 403, { ok: false, error: "FUTURES_DISABLED" });
    await ensureSchema();
    if (path === "/api/futures/markets") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      if (rateLimited(req, res, "fut-markets", clientKey(req), 90)) return;
      await lazySweep();
      return send(res, 200, await listMarkets());
    }
    const s = readSession(req);
    if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
    if (rateLimited(req, res, "fut-trading", s.id, 40)) return;
    if (path === "/api/futures/account") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      await lazySweep();
      return send(res, 200, { ok: true, ...(await accountView(s.id)) });
    }
    if (path === "/api/futures/orders") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const status = new URL(req.url, "https://x.invalid").searchParams.get("status") === "history" ? "history" : "open";
      const r = await db().query(
        `SELECT o.*, m.symbol FROM futures_orders o JOIN futures_markets m ON m.id=o.market_id
          WHERE o.user_id=$1 AND (($2='open' AND o.status='open') OR ($2='history' AND o.status<>'open')) ORDER BY o.id DESC LIMIT 100`, [s.id, status]);
      return send(res, 200, { ok: true, orders: r.rows.map(orderView) });
    }
    if (path === "/api/futures/trades") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const r = await db().query(
        `SELECT t.*, m.symbol FROM futures_trades t JOIN futures_markets m ON m.id=t.market_id WHERE t.user_id=$1 ORDER BY t.id DESC LIMIT 100`, [s.id]);
      return send(res, 200, { ok: true, trades: r.rows.map(t => ({
        id: Number(t.id), symbol: t.symbol, side: t.side, kind: t.kind, quantity: String(t.quantity), price: String(t.price),
        fee: String(t.fee), realizedPnl: String(t.realized_pnl), createdAt: t.created_at })) });
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await ensureWallet(s.id);
    if (path === "/api/futures/transfer") return send(res, 200, { ok: true, ...(await transfer(s.id, req.body || {})) });
    if (path === "/api/futures/order") return send(res, 201, { ok: true, ...(await placeOrder(s.id, req.body || {})) });
    if (path === "/api/futures/cancel") return send(res, 200, { ok: true, ...(await cancelOrder(s.id, Number(req.body?.orderId))) });
    if (path === "/api/futures/close") return send(res, 200, { ok: true, ...(await closePosition(s.id, req.body?.symbol)) });
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    const msg = String(e?.message || "");
    const status = BAD_REQUEST.has(msg) ? 400 : CONFLICT.has(msg) ? 409 : msg === "PRICE_UNAVAILABLE" ? 503 : 500;
    if (status === 500) console.error("FUTURES_ERROR", path, msg);
    return send(res, status, { ok: false, error: status === 500 ? "FUTURES_FAILED" : msg });
  }
}
