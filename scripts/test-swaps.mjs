// Run: node scripts/test-swaps.mjs   (pure parsers, no DB, no network)
import assert from "node:assert/strict";
import { parseSolanaSwaps, parseTronPool, parseTonJettons, tonHash, SOL_WSOL } from "../lib/swap_parsers.js";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const MINT = "PumpMint11111111111111111111111111111111pump", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", U = "Trader11111111111111111111111111111111111";
const tok = (mint, amount, dec = 6) => ({ userAccount: U, mint, rawTokenAmount: { tokenAmount: String(amount), decimals: dec } });
const sw = (sig, swap, extra = {}) => ({ signature: sig, timestamp: 1700000000, feePayer: U, events: { swap }, ...extra });

t("Solana: SOL -> token = BUY, USD via SOL price", () => {
  const r = parseSolanaSwaps([sw("s1", { nativeInput: { account: U, amount: "2000000000" }, tokenInputs: [], tokenOutputs: [tok(MINT, 5_000_000_000)] })], MINT, 150);
  const x = r.trades[0]; assert.equal(x.side, "BUY"); near(x.tokenAmount, 5000); near(x.quoteAmount, 2); near(x.usd, 300); assert.equal(x.trader, U);
});
t("Solana: token -> USDC = SELL, USD = USDC amount", () => {
  const r = parseSolanaSwaps([sw("s2", { tokenInputs: [tok(MINT, 1_000_000_000)], tokenOutputs: [tok(USDC, 450_000_000)] })], MINT, 150);
  assert.equal(r.trades[0].side, "SELL"); near(r.trades[0].usd, 450); assert.equal(r.trades[0].quoteSymbol, "USDC");
});
t("Solana: token -> native SOL out = SELL", () => {
  const r = parseSolanaSwaps([sw("s3", { nativeOutput: { account: U, amount: "1000000000" }, tokenInputs: [tok(MINT, 2_000_000)], tokenOutputs: [] })], MINT, 100);
  assert.equal(r.trades[0].side, "SELL"); near(r.trades[0].usd, 100);
});
t("Solana: wSOL as quote counts as SOL", () => {
  const r = parseSolanaSwaps([sw("s4", { tokenInputs: [tok(SOL_WSOL, 3_000_000_000, 9)], tokenOutputs: [tok(MINT, 1_000_000)] })], MINT, 100);
  assert.equal(r.trades[0].side, "BUY"); near(r.trades[0].quoteAmount, 3);
});
t("Solana: other token, failed tx, unknown quote are skipped (never guessed)", () => {
  const r = parseSolanaSwaps([
    sw("a", { nativeInput: { account: U, amount: "1" }, tokenOutputs: [tok("OtherMint1111111111111111111111111111111111", 1)] }),
    sw("b", { nativeInput: { account: U, amount: "1" }, tokenOutputs: [tok(MINT, 1)] }, { transactionError: { e: 1 } }),
    sw("c", { tokenInputs: [tok("WeirdQuote111111111111111111111111111111111", 5)], tokenOutputs: [tok(MINT, 1000)] }),
    { signature: "d", timestamp: 1, events: {} }], MINT, 100);
  assert.equal(r.trades.length, 0); assert.equal(r.skipped.other_token, 1); assert.equal(r.skipped.unknown_quote, 1);
});

const POOL = "TPoo1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx", TOK = "TTokenxxxxxxxxxxxxxxxxxxxxxxxxxxxx", USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
const tr = (id, from, to, value, address, dec = 6, ts = 1700000000000) => ({ transaction_id: id, block_timestamp: ts, from, to, value: String(value), token_info: { address, decimals: dec, symbol: "X" } });
t("Tron: USDT in + token out of pool = BUY", () => {
  const r = parseTronPool([tr("t1", "TUser", POOL, 100_000_000, USDT), tr("t1", POOL, "TUser", 5_000_000_000, TOK, 6)], { pool: POOL, token: TOK });
  const x = r.trades[0]; assert.equal(x.side, "BUY"); near(x.usd, 100); near(x.tokenAmount, 5000); assert.equal(x.trader, "TUser");
});
t("Tron: token in + WTRX out = SELL priced with TRX", () => {
  const r = parseTronPool([tr("t2", "TUser", POOL, 1_000_000, TOK, 6), tr("t2", POOL, "TUser", 500_000_000, WTRX, 6)], { pool: POOL, token: TOK, trxUsd: 0.2 });
  assert.equal(r.trades[0].side, "SELL"); near(r.trades[0].usd, 100); assert.equal(r.trades[0].quoteSymbol, "TRX");
});
t("Tron: liquidity add / remove / plain transfer are NOT trades", () => {
  const add = parseTronPool([tr("a", "TLp", POOL, 100, TOK), tr("a", "TLp", POOL, 100, USDT)], { pool: POOL, token: TOK });
  const rem = parseTronPool([tr("b", POOL, "TLp", 100, TOK), tr("b", POOL, "TLp", 100, USDT)], { pool: POOL, token: TOK });
  const one = parseTronPool([tr("c", "TFriend", POOL, 100, TOK)], { pool: POOL, token: TOK });
  assert.equal(add.trades.length + rem.trades.length + one.trades.length, 0); assert.equal(add.skipped.not_a_swap, 1);
});

const PHASH = "ab".repeat(32);
t("TON: raw and friendly address forms resolve to the same hash", () => {
  assert.equal(tonHash("0:" + PHASH.toUpperCase()), PHASH);
  const friendly = Buffer.concat([Buffer.from([0x11, 0x00]), Buffer.from(PHASH, "hex"), Buffer.from([0, 0])]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(tonHash(friendly), PHASH); assert.equal(tonHash("garbage"), "");
});
t("TON (beta): tokens leaving pool = BUY, entering = SELL, USD is an estimate", () => {
  const rows = [{ source: "0:" + PHASH, destination: "0:" + "cd".repeat(32), amount: "2000000000000", transaction_hash: "h1", transaction_now: 1700000000 },
                { source: "0:" + "cd".repeat(32), destination: "0:" + PHASH, amount: "1000000000000", transaction_hash: "h2", transaction_now: 1700000001 },
                { source: "0:" + "01".repeat(32), destination: "0:" + "02".repeat(32), amount: "5", transaction_hash: "h3", transaction_now: 1 }];
  const r = parseTonJettons(rows, { pool: "0:" + PHASH, priceUsd: 0.5 });
  assert.equal(r.trades.length, 2); assert.equal(r.trades[0].side, "BUY"); assert.equal(r.trades[1].side, "SELL");
  near(r.trades[0].usd, 1000); assert.equal(r.trades[0].estimate, true); assert.equal(r.skipped.not_pool_transfer, 1);
});
console.log(`\n${pass} passed`);
