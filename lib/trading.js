// Internal custodial spot exchange. Orders are matched against the internal limit book only.
// No external wallet signing, DEX execution or simulated fills.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited, clientKey } from "./ratelimit.js";
import { ensureWallet, ensureWalletSchema, withTx, postLedger } from "./wallet.js";

const SCALE = 10n ** 18n;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/;
const PRICE_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/;
const clean = v => String(v ?? "").trim();
const asUnits = v => {
  const s = String(v ?? "");
  if (!AMOUNT_RE.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * SCALE + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const fmt = n => {
  const neg = n < 0n ? "-" : "";
  if (n < 0n) n = -n;
  const whole = n / SCALE;
  const frac = (n % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return neg + whole.toString() + (frac ? "." + frac : "");
};
const mul = (a, b) => (a * b) / SCALE;
const feeFor = (notional, bps) => (notional * BigInt(bps)) / 10000n;
const minBig = (a, b) => a < b ? a : b;
const maxBig = (a, b) => a > b ? a : b;
const feeBps = () => {
  const n = Number(process.env.SPOT_TAKER_FEE_BPS ?? 10);
  return Number.isInteger(n) && n >= 0 && n <= 500 ? n : 10;
};

let schemaPromise;
async function ensureTradingSchema() {
  await ensureWalletSchema();
  if (!schemaPromise) schemaPromise = (async () => {
    const c = await db().connect();
    try {
      await c.query("SELECT pg_advisory_lock(7731002)");
      await c.query(`
        ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_kind_check;
        ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check
          CHECK (kind IN ('deposit','withdraw_lock','withdraw_fee','withdraw_complete','withdraw_release','adjustment',
                          'trade_lock','trade_release','trade_buy','trade_sell','trade_fee'));
        CREATE TABLE IF NOT EXISTS spot_markets (
          id BIGSERIAL PRIMARY KEY,
          symbol TEXT NOT NULL UNIQUE,
          base_asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
          quote_asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
          base_symbol TEXT NOT NULL,
          quote_symbol TEXT NOT NULL DEFAULT 'USDT',
          chain TEXT NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(base_asset_id,quote_asset_id),
          CHECK(base_asset_id <> quote_asset_id)
        );
        CREATE TABLE IF NOT EXISTS spot_orders (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          market_id BIGINT NOT NULL REFERENCES spot_markets(id),
          side TEXT NOT NULL CHECK(side IN ('buy','sell')),
          order_type TEXT NOT NULL CHECK(order_type IN ('market','limit')),
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','partially_filled','filled','cancelled')),
          quantity NUMERIC(38,18) NOT NULL CHECK(quantity > 0),
          filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK(filled_quantity >= 0),
          remaining_quantity NUMERIC(38,18) NOT NULL CHECK(remaining_quantity >= 0),
          limit_price NUMERIC(38,18),
          fee_bps INTEGER NOT NULL DEFAULT 10 CHECK(fee_bps BETWEEN 0 AND 500),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK((order_type='market' AND limit_price IS NULL) OR (order_type='limit' AND limit_price > 0))
        );
        ALTER TABLE spot_orders ADD COLUMN IF NOT EXISTS fee_bps INTEGER NOT NULL DEFAULT 10 CHECK(fee_bps BETWEEN 0 AND 500);
        CREATE INDEX IF NOT EXISTS idx_spot_orders_book ON spot_orders(market_id,side,status,limit_price,created_at,id);
        CREATE INDEX IF NOT EXISTS idx_spot_orders_user ON spot_orders(user_id,id DESC);
        CREATE TABLE IF NOT EXISTS spot_trades (
          id BIGSERIAL PRIMARY KEY,
          market_id BIGINT NOT NULL REFERENCES spot_markets(id),
          buy_order_id BIGINT NOT NULL REFERENCES spot_orders(id),
          sell_order_id BIGINT NOT NULL REFERENCES spot_orders(id),
          buyer_user_id BIGINT NOT NULL REFERENCES users(id),
          seller_user_id BIGINT NOT NULL REFERENCES users(id),
          price NUMERIC(38,18) NOT NULL CHECK(price > 0),
          quantity NUMERIC(38,18) NOT NULL CHECK(quantity > 0),
          quote_amount NUMERIC(38,18) NOT NULL CHECK(quote_amount > 0),
          buyer_fee NUMERIC(38,18) NOT NULL DEFAULT 0,
          seller_fee NUMERIC(38,18) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spot_trades_market ON spot_trades(market_id,id DESC);
        CREATE INDEX IF NOT EXISTS idx_spot_trades_users ON spot_trades(buyer_user_id,id DESC,seller_user_id);
      `);
      // Build the supported internal markets from assets that share a chain with a USDT quote asset.
      await c.query(`
        INSERT INTO spot_markets(symbol,base_asset_id,quote_asset_id,base_symbol,quote_symbol,chain)
        SELECT upper(b.symbol || 'USDT-' || b.chain), b.id, q.id, b.symbol, 'USDT', b.chain
          FROM wallet_assets b
          JOIN wallet_assets q ON q.chain=b.chain AND q.symbol='USDT'
         WHERE b.symbol <> 'USDT'
           AND b.deposit_enabled=TRUE
           AND q.deposit_enabled=TRUE
        ON CONFLICT (base_asset_id,quote_asset_id) DO NOTHING
      `);
    } finally {
      try { await c.query("SELECT pg_advisory_unlock(7731002)"); } catch {}
      c.release();
    }
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

function orderView(r) {
  return {
    id: Number(r.id), market: r.symbol, side: r.side, type: r.order_type, status: r.status,
    quantity: String(r.quantity), filledQuantity: String(r.filled_quantity),
    remainingQuantity: String(r.remaining_quantity), price: r.limit_price == null ? null : String(r.limit_price),
    createdAt: r.created_at
  };
}

async function getMarket(marketId) {
  const r = await db().query(
    `SELECT m.*,b.code AS base_code,q.code AS quote_code,b.decimals AS base_decimals,q.decimals AS quote_decimals
       FROM spot_markets m JOIN wallet_assets b ON b.id=m.base_asset_id
       JOIN wallet_assets q ON q.id=m.quote_asset_id
      WHERE m.id=$1 AND m.is_active=TRUE`, [marketId]);
  return r.rows[0] || null;
}

async function listMarkets(req, res) {
  const r = await db().query(`
    SELECT m.id,m.symbol,m.base_symbol,m.quote_symbol,m.chain,b.code AS base_code,q.code AS quote_code,
           COALESCE(t.price,0)::text AS last_price,
           COALESCE(t.volume,0)::text AS last_quantity,
           t.created_at AS last_trade_at
      FROM spot_markets m
      JOIN wallet_assets b ON b.id=m.base_asset_id
      JOIN wallet_assets q ON q.id=m.quote_asset_id
      LEFT JOIN LATERAL (
        SELECT price,quantity AS volume,created_at FROM spot_trades
         WHERE market_id=m.id ORDER BY id DESC LIMIT 1
      ) t ON TRUE
     WHERE m.is_active=TRUE ORDER BY m.chain,m.base_symbol`);
  return send(res, 200, { ok:true, markets:r.rows.map(x=>({...x,id:Number(x.id)})) });
}

async function orderBook(req, res) {
  const u = new URL(req.url, "https://x.invalid");
  const marketId = Number(u.searchParams.get("market"));
  if (!Number.isSafeInteger(marketId) || marketId < 1) return send(res,400,{ok:false,error:"INVALID_MARKET"});
  const market = await getMarket(marketId);
  if (!market) return send(res,404,{ok:false,error:"MARKET_NOT_FOUND"});
  const [bids,asks,last] = await Promise.all([
    db().query(`SELECT limit_price::text AS price,SUM(remaining_quantity)::text AS quantity,COUNT(*)::int AS orders
                  FROM spot_orders WHERE market_id=$1 AND side='buy' AND status IN ('open','partially_filled')
                 GROUP BY limit_price ORDER BY limit_price DESC LIMIT 20`,[marketId]),
    db().query(`SELECT limit_price::text AS price,SUM(remaining_quantity)::text AS quantity,COUNT(*)::int AS orders
                  FROM spot_orders WHERE market_id=$1 AND side='sell' AND status IN ('open','partially_filled')
                 GROUP BY limit_price ORDER BY limit_price ASC LIMIT 20`,[marketId]),
    db().query(`SELECT price::text,quantity::text,created_at FROM spot_trades WHERE market_id=$1 ORDER BY id DESC LIMIT 1`,[marketId])
  ]);
  return send(res,200,{ok:true,market:{id:Number(market.id),symbol:market.symbol,base:market.base_symbol,quote:market.quote_symbol,chain:market.chain},
    bids:bids.rows,asks:asks.rows,lastTrade:last.rows[0]||null});
}

async function myOrders(req, res, userId) {
  const u = new URL(req.url,"https://x.invalid");
  const marketId = Number(u.searchParams.get("market")) || null;
  const limit = Math.min(100,Math.max(1,Number(u.searchParams.get("limit"))||50));
  const r = await db().query(`
    SELECT o.*,m.symbol FROM spot_orders o JOIN spot_markets m ON m.id=o.market_id
     WHERE o.user_id=$1 AND ($2::bigint IS NULL OR o.market_id=$2)
     ORDER BY o.id DESC LIMIT $3`,[userId,marketId,limit]);
  return send(res,200,{ok:true,orders:r.rows.map(orderView)});
}

async function myTrades(req, res, userId) {
  const u = new URL(req.url,"https://x.invalid");
  const marketId = Number(u.searchParams.get("market")) || null;
  const limit = Math.min(100,Math.max(1,Number(u.searchParams.get("limit"))||50));
  const r = await db().query(`
    SELECT t.*,m.symbol FROM spot_trades t JOIN spot_markets m ON m.id=t.market_id
     WHERE (t.buyer_user_id=$1 OR t.seller_user_id=$1)
       AND ($2::bigint IS NULL OR t.market_id=$2)
     ORDER BY t.id DESC LIMIT $3`,[userId,marketId,limit]);
  return send(res,200,{ok:true,trades:r.rows.map(x=>({
    id:Number(x.id),market:x.symbol,side:Number(x.buyer_user_id)===Number(userId)?"buy":"sell",
    price:String(x.price),quantity:String(x.quantity),quoteAmount:String(x.quote_amount),
    createdAt:x.created_at
  }))});
}

async function balanceFor(c,userId,assetId) {
  await c.query(`INSERT INTO user_balances(user_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[userId,assetId]);
  const r=await c.query(`SELECT available::text,locked::text FROM user_balances WHERE user_id=$1 AND asset_id=$2 FOR UPDATE`,[userId,assetId]);
  return r.rows[0];
}

async function executeOrder(userId, body) {
  const marketId=Number(body.marketId), side=clean(body.side).toLowerCase(), type=clean(body.type).toLowerCase();
  const qty=asUnits(body.quantity), price=type==="limit"?asUnits(body.price):null;
  if(!Number.isSafeInteger(marketId)||marketId<1||!["buy","sell"].includes(side)||!["market","limit"].includes(type)||qty===null||qty<=0n||(type==="limit"&&(!price||price<=0n))) throw new Error("INVALID_ORDER");
  const market=await getMarket(marketId);
  if(!market) throw new Error("MARKET_NOT_FOUND");
  const baseDp=Number(market.base_decimals||18),quoteDp=Number(market.quote_decimals||18);
  if((String(body.quantity).split(".")[1]||"").length>baseDp ||
     (type==="limit"&&(String(body.price).split(".")[1]||"").length>quoteDp)) throw new Error("INVALID_ORDER_PRECISION");
  const bps=feeBps();
  return withTx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock($1)",[Number(market.id)]);
    const user=await c.query(`SELECT is_blocked FROM users WHERE id=$1`,[userId]);
    if(!user.rowCount||user.rows[0].is_blocked) throw new Error("ACCOUNT_BLOCKED");
    const incoming=await c.query(`
      INSERT INTO spot_orders(user_id,market_id,side,order_type,status,quantity,remaining_quantity,limit_price,fee_bps)
      VALUES($1,$2,$3,$4,'open',$5::numeric,$5::numeric,$6::numeric,$7)
      RETURNING *`,[userId,market.id,side,type,fmt(qty),price===null?null:fmt(price),bps]);
    const order=incoming.rows[0];
    const quoteAsset=Number(market.quote_asset_id),baseAsset=Number(market.base_asset_id);
    if(type==="limit"){
      if(side==="buy"){
        const reserve=mul(price,qty), total=reserve+feeFor(reserve,bps);
        await postLedger(c,{userId,assetId:quoteAsset,kind:"trade_lock",deltaAvailable:fmt(-total),deltaLocked:fmt(total),refType:"spot_order",refId:String(order.id),note:"Spot limit buy funds reserved"});
      }else{
        await postLedger(c,{userId,assetId:baseAsset,kind:"trade_lock",deltaAvailable:fmt(-qty),deltaLocked:fmt(qty),refType:"spot_order",refId:String(order.id),note:"Spot limit sell asset reserved"});
      }
    }
    let remaining=qty,filled=0n,fillCount=0;
    while(remaining>0n){
      const opposite=side==="buy"?"sell":"buy";
      const cond=type==="limit"
        ? (side==="buy"?"AND limit_price <= $4::numeric":"AND limit_price >= $4::numeric")
        : "";
      const params=[market.id,opposite,userId];
      if(type==="limit") params.push(fmt(price));
      const makerQ=await c.query(`
        SELECT * FROM spot_orders
         WHERE market_id=$1 AND side=$2 AND user_id<>$3
           AND order_type='limit' AND status IN ('open','partially_filled')
           ${cond}
         ORDER BY CASE WHEN side='sell' THEN limit_price END ASC,
                  CASE WHEN side='buy' THEN limit_price END DESC,
                  created_at ASC,id ASC
         LIMIT 1 FOR UPDATE`,params);
      if(!makerQ.rowCount) break;
      const maker=makerQ.rows[0];
      const makerRemaining=asUnits(maker.remaining_quantity);
      const tradeQty=minBig(remaining,makerRemaining);
      const tradePrice=asUnits(maker.limit_price);
      const quote=mul(tradePrice,tradeQty);
      const buyerFee=feeFor(quote,Number((side==="buy"?order:maker).fee_bps)),sellerFee=feeFor(quote,Number((side==="sell"?order:maker).fee_bps));
      const buyerOrder=side==="buy"?order:maker;
      const sellerOrder=side==="sell"?order:maker;
      const buyerId=Number(buyerOrder.user_id),sellerId=Number(sellerOrder.user_id);
      const tradeIns=await c.query(`
        INSERT INTO spot_trades(market_id,buy_order_id,sell_order_id,buyer_user_id,seller_user_id,price,quantity,quote_amount,buyer_fee,seller_fee)
        VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric)
        RETURNING id`,[market.id,buyerOrder.id,sellerOrder.id,buyerId,sellerId,fmt(tradePrice),fmt(tradeQty),fmt(quote),fmt(buyerFee),fmt(sellerFee)]);
      const tradeId=String(tradeIns.rows[0].id);
      // Buyer pays quote; a resting limit buyer receives any price-improvement reserve back.
      if(buyerOrder.order_type==="limit"){
        const reserveAtLimit=mul(asUnits(buyerOrder.limit_price),tradeQty);
        const reserveTotal=reserveAtLimit+feeFor(reserveAtLimit,Number(buyerOrder.fee_bps));
        const actual=quote+buyerFee;
        const refund=reserveTotal-actual;
        await postLedger(c,{userId:buyerId,assetId:quoteAsset,kind:"trade_buy",deltaAvailable:fmt(refund),deltaLocked:fmt(-reserveTotal),refType:"spot_trade",refId:tradeId+":buyer-quote",note:"Spot buy settlement"});
      }else{
        await postLedger(c,{userId:buyerId,assetId:quoteAsset,kind:"trade_buy",deltaAvailable:fmt(-(quote+buyerFee)),refType:"spot_trade",refId:tradeId+":buyer-quote",note:"Spot market buy settlement"});
      }
      await postLedger(c,{userId:buyerId,assetId:baseAsset,kind:"trade_buy",deltaAvailable:fmt(tradeQty),refType:"spot_trade",refId:tradeId+":buyer-base",note:"Spot asset purchased"});
      // Seller delivers base and receives quote less the seller fee.
      if(sellerOrder.order_type==="limit"){
        await postLedger(c,{userId:sellerId,assetId:baseAsset,kind:"trade_sell",deltaLocked:fmt(-tradeQty),refType:"spot_trade",refId:tradeId+":seller-base",note:"Spot sell settlement"});
      }else{
        await postLedger(c,{userId:sellerId,assetId:baseAsset,kind:"trade_sell",deltaAvailable:fmt(-tradeQty),refType:"spot_trade",refId:tradeId+":seller-base",note:"Spot market sell settlement"});
      }
      await postLedger(c,{userId:sellerId,assetId:quoteAsset,kind:"trade_sell",deltaAvailable:fmt(quote-sellerFee),refType:"spot_trade",refId:tradeId+":seller-quote",note:"Spot sale proceeds"});
      // Fees are retained as platform revenue and recorded on the trade row; never shown in the trading UI.
      remaining-=tradeQty;filled+=tradeQty;fillCount++;
      const makerNew=makerRemaining-tradeQty;
      await c.query(`UPDATE spot_orders SET filled_quantity=filled_quantity+$2::numeric,remaining_quantity=$3::numeric,
        status=CASE WHEN $3::numeric=0 THEN 'filled' ELSE 'partially_filled' END,updated_at=NOW() WHERE id=$1`,
        [maker.id,fmt(tradeQty),fmt(makerNew)]);
      const incomingNew=remaining;
      await c.query(`UPDATE spot_orders SET filled_quantity=filled_quantity+$2::numeric,remaining_quantity=$3::numeric,
        status=CASE WHEN $3::numeric=0 THEN 'filled' WHEN order_type='market' THEN 'cancelled' ELSE 'partially_filled' END,updated_at=NOW() WHERE id=$1`,
        [order.id,fmt(tradeQty),fmt(incomingNew)]);
      if(type==="market") {
        // A market order is immediate-or-cancel; unfilled remainder is never left on the book.
        if(remaining>0n) break;
      }
    }
    if(type==="market" && remaining>0n){
      await c.query(`UPDATE spot_orders SET status=CASE WHEN filled_quantity>0 THEN 'cancelled' ELSE 'cancelled' END,remaining_quantity=0,updated_at=NOW() WHERE id=$1`,[order.id]);
    } else if(type==="limit" && remaining>0n) {
      await c.query(`UPDATE spot_orders SET status=CASE WHEN filled_quantity>0 THEN 'partially_filled' ELSE 'open' END,updated_at=NOW() WHERE id=$1`,[order.id]);
    }
    const final=await c.query(`SELECT * FROM spot_orders WHERE id=$1`,[order.id]);
    return {order:orderView({...final.rows[0],symbol:market.symbol}),filledQuantity:fmt(filled),fills:fillCount};
  });
}

async function cancelOrder(userId,id) {
  if(!Number.isSafeInteger(id)||id<1) throw new Error("INVALID_ORDER_ID");
  return withTx(async c=>{
    const q=await c.query(`SELECT o.*,m.quote_asset_id,m.base_asset_id,m.symbol FROM spot_orders o JOIN spot_markets m ON m.id=o.market_id WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE`,[id,userId]);
    if(!q.rowCount) throw new Error("ORDER_NOT_FOUND");
    const o=q.rows[0];
    if(!["open","partially_filled"].includes(o.status)) throw new Error("ORDER_NOT_OPEN");
    const remaining=asUnits(o.remaining_quantity);
    if(o.side==="buy"){
      const p=asUnits(o.limit_price);
      const reserve=mul(p,remaining),total=reserve+feeFor(reserve,Number(o.fee_bps));
      await postLedger(c,{userId,assetId:Number(o.quote_asset_id),kind:"trade_release",deltaAvailable:fmt(total),deltaLocked:fmt(-total),refType:"spot_order_cancel",refId:String(id),note:"Unused spot buy reservation released"});
    }else{
      await postLedger(c,{userId,assetId:Number(o.base_asset_id),kind:"trade_release",deltaAvailable:fmt(remaining),deltaLocked:fmt(-remaining),refType:"spot_order_cancel",refId:String(id),note:"Unused spot sell reservation released"});
    }
    await c.query(`UPDATE spot_orders SET status='cancelled',remaining_quantity=0,updated_at=NOW() WHERE id=$1`,[id]);
    return {id,status:"cancelled"};
  });
}

export async function tradingApi(req,res,path){
  try{
    await ensureTradingSchema();
    if(path==="/api/trading/markets"){
      if(req.method!=="GET") return methodNotAllowed(res,["GET"]);
      if(rateLimited(req,res,"spot-markets",clientKey(req),60)) return;
      return await listMarkets(req,res);
    }
    if(path==="/api/trading/orderbook"){
      if(req.method!=="GET") return methodNotAllowed(res,["GET"]);
      if(rateLimited(req,res,"spot-book",clientKey(req),90)) return;
      return await orderBook(req,res);
    }
    const s=readSession(req);
    if(!s) return send(res,401,{ok:false,error:"AUTH_REQUIRED"});
    if(rateLimited(req,res,"spot-trading",s.id,30)) return;
    if(path==="/api/trading/orders"){
      if(req.method!=="GET") return methodNotAllowed(res,["GET"]);
      return await myOrders(req,res,s.id);
    }
    if(path==="/api/trading/trades"){
      if(req.method!=="GET") return methodNotAllowed(res,["GET"]);
      return await myTrades(req,res,s.id);
    }
    if(path==="/api/trading/order"){
      if(req.method!=="POST") return methodNotAllowed(res,["POST"]);
      await ensureWallet(s.id);
      const result=await executeOrder(s.id,req.body||{});
      return send(res,201,{ok:true,...result});
    }
    if(path==="/api/trading/cancel"){
      if(req.method!=="POST") return methodNotAllowed(res,["POST"]);
      const result=await cancelOrder(s.id,Number(req.body?.orderId));
      return send(res,200,{ok:true,...result});
    }
    return send(res,404,{ok:false,error:"API_ROUTE_NOT_FOUND"});
  }catch(e){
    const msg=String(e?.message||"");
    const status=["INVALID_ORDER","INVALID_ORDER_PRECISION","INVALID_ORDER_ID","MARKET_NOT_FOUND","ORDER_NOT_FOUND","ORDER_NOT_OPEN","ACCOUNT_BLOCKED"].includes(msg)?400:
      msg==="INSUFFICIENT_BALANCE"?409:500;
    if(status===500) console.error("SPOT_TRADING_ERROR",path,msg);
    return send(res,status,{ok:false,error:msg||"SPOT_TRADING_FAILED"});
  }
}
