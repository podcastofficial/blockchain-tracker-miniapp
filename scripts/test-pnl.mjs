// Run: node scripts/test-pnl.mjs   (pure functions, no DB, no network)
import assert from "node:assert/strict";
import { computePnl, parseEvm, parseHelius, parseTron, mergeTrades, buildTrade } from "../lib/pnl_engine.js";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const tok = { symbol: "PEPE", key: "ethereum:0xpepe" };
const mk = (id, ts, side, amount, usdValue, feeUsd = 0, token = tok) => ({ id, ts, network: "ethereum", wallet: "0xw", txHash: "0x" + id, side, token, amount, usdValue, feeUsd });

t("1 buy, 1 sell, profit", () => {
  const r = computePnl([mk("a", 1, "buy", 100, 100), mk("b", 2, "sell", 100, 150)]);
  near(r.summary.realizedUsd, 50); assert.equal(r.summary.winRate, 1); assert.equal(r.summary.closedTrades, 1);
  near(r.summary.unrealizedUsd, 0);
});
t("loss counts as a loss in win-rate", () => {
  const r = computePnl([mk("a", 1, "buy", 10, 100), mk("b", 2, "sell", 10, 60), mk("c", 3, "buy", 10, 100), mk("d", 4, "sell", 10, 130)]);
  near(r.summary.realizedUsd, -10); assert.equal(r.summary.winRate, 0.5);
  assert.equal(r.summary.best.pnlUsd, 30); assert.equal(r.summary.worst.pnlUsd, -40);
});
t("partial sell leaves remaining lot, unrealized uses last trade price", () => {
  const r = computePnl([mk("a", 1, "buy", 100, 100), mk("b", 2, "sell", 40, 80)]);
  near(r.summary.realizedUsd, 40);                       // 80 - 40*1
  near(r.byToken[0].holding, 60);
  near(r.summary.unrealizedUsd, 60 * 2 - 60);            // last trade price 2.0, cost 1.0
  assert.equal(r.byToken[0].markSource, "last_trade");
});
t("live mark overrides last trade price", () => {
  const r = computePnl([mk("a", 1, "buy", 100, 100)], { marks: { "ethereum:0xpepe": 3 } });
  near(r.summary.unrealizedUsd, 200); assert.equal(r.byToken[0].markSource, "live");
});
t("FIFO: sell crosses two lots at different prices", () => {
  const r = computePnl([mk("a", 1, "buy", 10, 10), mk("b", 2, "buy", 10, 30), mk("c", 3, "sell", 15, 60)]);
  // cost = 10*1 + 5*3 = 25 ; proceeds 60 ; pnl 35 ; left 5 @ 3
  near(r.summary.realizedUsd, 35); near(r.byToken[0].holding, 5);
});
t("fees reduce profit on both sides", () => {
  const r = computePnl([mk("a", 1, "buy", 100, 100, 2), mk("b", 2, "sell", 100, 150, 3)]);
  near(r.summary.realizedUsd, 150 - 3 - 102);
});
t("sell without a seen buy => unknown cost, NOT counted as profit", () => {
  const r = computePnl([mk("b", 2, "sell", 100, 500)]);
  near(r.summary.realizedUsd, 0); assert.equal(r.summary.closedTrades, 0); assert.equal(r.byToken[0].unknownCost, true);
  assert.equal(r.unknownCostTokens, 1);
});
t("sell bigger than bought: matched part counts, flag set", () => {
  const r = computePnl([mk("a", 1, "buy", 50, 50), mk("b", 2, "sell", 100, 200)]);
  near(r.summary.realizedUsd, 100 - 50);                 // only 50 matched: proceeds 100, cost 50
  assert.equal(r.byToken[0].unknownCost, true);
});
t("window: old sell does not count, but its buy still builds the lots", () => {
  const r = computePnl([mk("a", 1, "buy", 10, 10), mk("b", 5, "sell", 5, 50), mk("c", 20, "sell", 5, 25)], { sinceTs: 10 });
  assert.equal(r.summary.closedTrades, 1); near(r.summary.realizedUsd, 25 - 5);
});
t("empty input => zero summary, no error", () => {
  const r = computePnl([]);
  assert.equal(r.summary.realizedUsd, 0); assert.equal(r.summary.winRate, null); assert.equal(r.summary.best, null);
});
t("mergeTrades dedupes by id and caps", () => {
  const m = mergeTrades([mk("a", 1, "buy", 1, 1)], [mk("a", 1, "buy", 1, 1), mk("b", 2, "buy", 1, 1)], 10);
  assert.equal(m.length, 2); assert.equal(m[0].id, "b");
});

// ---- parsers ----
const W = "0x1111111111111111111111111111111111111111";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
const eth = (sym, ts) => (sym === "ETH" ? 2000 : undefined);
t("EVM: USDC -> token = buy, valued in USD", () => {
  const r = parseEvm({ network: "ethereum", wallet: W, priceAt: eth,
    txlist: [{ hash: "0xh1", timeStamp: "1700000000", from: W, to: "0xrouter", value: "0", gasUsed: "100000", gasPrice: "20000000000", isError: "0" }],
    tokentx: [{ hash: "0xh1", timeStamp: "1700000000", from: W, to: "0xp", value: "100000000", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: USDC },
              { hash: "0xh1", timeStamp: "1700000000", from: "0xp", to: W, value: "5000000000000000000000", tokenDecimal: "18", tokenSymbol: "PEPE", contractAddress: PEPE }] });
  assert.equal(r.trades.length, 1); const x = r.trades[0];
  assert.equal(x.side, "buy"); near(x.usdValue, 100); near(x.amount, 5000); near(x.feeUsd, 4);   // 100000 gas * 20 gwei = 0.002 ETH * $2000
});
t("EVM: token -> ETH = sell priced with native price", () => {
  const r = parseEvm({ network: "ethereum", wallet: W, priceAt: eth,
    txlist: [{ hash: "0xh2", timeStamp: "1700000100", from: W, to: "0xrouter", value: "0", gasUsed: "1", gasPrice: "1", isError: "0" }],
    tokentx: [{ hash: "0xh2", timeStamp: "1700000100", from: W, to: "0xp", value: "5000000000000000000000", tokenDecimal: "18", tokenSymbol: "PEPE", contractAddress: PEPE }],
    internal: [{ hash: "0xh2", timeStamp: "1700000100", from: "0xrouter", to: W, value: "100000000000000000", isError: "0" }] });
  assert.equal(r.trades[0].side, "sell"); near(r.trades[0].usdValue, 200);
});
t("EVM: ETH wrap (ETH out, WETH in) is NOT a trade", () => {
  const r = parseEvm({ network: "ethereum", wallet: W, priceAt: eth,
    txlist: [{ hash: "0xh3", timeStamp: "1700000200", from: W, to: WETH, value: "1000000000000000000", gasUsed: "1", gasPrice: "1", isError: "0" }],
    tokentx: [{ hash: "0xh3", timeStamp: "1700000200", from: WETH, to: W, value: "1000000000000000000", tokenDecimal: "18", tokenSymbol: "WETH", contractAddress: WETH }] });
  assert.equal(r.trades.length, 0);
});
t("EVM: plain transfer out is NOT a trade; token<->token skipped", () => {
  const r = parseEvm({ network: "ethereum", wallet: W, priceAt: eth, txlist: [],
    tokentx: [{ hash: "0xh4", timeStamp: "1", from: W, to: "0xz", value: "1000000", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: USDC },
              { hash: "0xh5", timeStamp: "1", from: W, to: "0xp", value: "1000000000000000000000", tokenDecimal: "18", tokenSymbol: "A", contractAddress: "0xaaa" },
              { hash: "0xh5", timeStamp: "1", from: "0xp", to: W, value: "1000000000000000000000", tokenDecimal: "18", tokenSymbol: "B", contractAddress: "0xbbb" }] });
  assert.equal(r.trades.length, 0); assert.equal(r.skipped.token_to_token, 1);
});
t("EVM: failed tx ignored; fake token named USDC is NOT a stablecoin", () => {
  const failed = parseEvm({ network: "ethereum", wallet: W, priceAt: eth,
    txlist: [{ hash: "0xh6", timeStamp: "1", from: W, to: "0xr", value: "0", gasUsed: "1", gasPrice: "1", isError: "1" }],
    tokentx: [{ hash: "0xh6", timeStamp: "1", from: W, to: "0xp", value: "1000000", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: USDC },
              { hash: "0xh6", timeStamp: "1", from: "0xp", to: W, value: "1000000000000000000000", tokenDecimal: "18", tokenSymbol: "P", contractAddress: PEPE }] });
  assert.equal(failed.trades.length, 0);
  const fake = parseEvm({ network: "ethereum", wallet: W, priceAt: eth, txlist: [],
    tokentx: [{ hash: "0xh7", timeStamp: "1", from: W, to: "0xp", value: "1000000", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: "0xfake" },
              { hash: "0xh7", timeStamp: "1", from: "0xp", to: W, value: "1000000000000000000000", tokenDecimal: "18", tokenSymbol: "P", contractAddress: PEPE }] });
  assert.equal(fake.trades.length, 0);
});
t("EVM: missing native price => skipped, never guessed", () => {
  const r = parseEvm({ network: "ethereum", wallet: W, priceAt: () => undefined,
    txlist: [{ hash: "0xh8", timeStamp: "1", from: W, to: "0xr", value: "1000000000000000000", gasUsed: "1", gasPrice: "1", isError: "0" }],
    tokentx: [{ hash: "0xh8", timeStamp: "1", from: "0xp", to: W, value: "1000000000000000000000", tokenDecimal: "18", tokenSymbol: "P", contractAddress: PEPE }] });
  assert.equal(r.trades.length, 0); assert.equal(r.skipped.price_missing, 1);
});
t("Solana (Helius): SOL -> pump token = buy valued in USD", () => {
  const SW = "SoLwa11etAddr111111111111111111111111111111", MINT = "PumpMint11111111111111111111111111111111pump";
  const r = parseHelius({ wallet: SW, priceAt: (s) => (s === "SOL" ? 150 : undefined), txs: [{ signature: "sig1", timestamp: 1700000000, fee: 5000, feePayer: SW,
    events: { swap: { nativeInput: { account: SW, amount: "2000000000" }, nativeOutput: null, tokenInputs: [],
      tokenOutputs: [{ userAccount: SW, mint: MINT, rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 } }] } } }] });
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].side, "buy"); near(r.trades[0].usdValue, 300); near(r.trades[0].amount, 1000);
});
t("Solana (Helius): token -> USDC = sell valued at USDC amount", () => {
  const SW = "SoLwa11etAddr111111111111111111111111111111", MINT = "PumpMint11111111111111111111111111111111pump", USD = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const r = parseHelius({ wallet: SW, priceAt: () => 150, txs: [{ signature: "sig2", timestamp: 1700000100, fee: 5000, feePayer: SW,
    events: { swap: { nativeInput: null, nativeOutput: null,
      tokenInputs: [{ userAccount: SW, mint: MINT, rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 } }],
      tokenOutputs: [{ userAccount: SW, mint: USD, rawTokenAmount: { tokenAmount: "450000000", decimals: 6 } }] } } }] });
  assert.equal(r.trades[0].side, "sell"); near(r.trades[0].usdValue, 450);
});
t("Tron: TRC20 token <-> USDT swap detected, plain transfer ignored", () => {
  const TW = "TWalletxxxxxxxxxxxxxxxxxxxxxxxxxx", USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const r = parseTron({ wallet: TW, priceAt: () => 0.1, transfers: [
    { transaction_id: "t1", block_timestamp: 1700000000000, from: TW, to: "TPool", value: "100000000", token_info: { symbol: "USDT", address: USDT, decimals: 6 } },
    { transaction_id: "t1", block_timestamp: 1700000000000, from: "TPool", to: TW, value: "5000000000", token_info: { symbol: "SUN", address: "TSunAddr", decimals: 18 } },
    { transaction_id: "t2", block_timestamp: 1700000001000, from: TW, to: "TFriend", value: "1000000", token_info: { symbol: "USDT", address: USDT, decimals: 6 } }] });
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].side, "buy"); near(r.trades[0].usdValue, 100);
});
t("buildTrade: stable<->stable is skipped", () => {
  const r = buildTrade({ ts: 1, hash: "h", network: "ethereum", wallet: "w", priceAt: eth,
    legs: [{ key: "a", symbol: "USDC", kind: "stable", amount: -10 }, { key: "b", symbol: "DAI", kind: "stable", amount: 10 }] });
  assert.equal(r.skip, "no_asset");
});
console.log(`\n${pass} passed`);
