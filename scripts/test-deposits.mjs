// node scripts/test-deposits.mjs  — offline tests for deposit auto-detect (no DB, no network: fetch is mocked).
import assert from "node:assert/strict";
import { matchTransfer, bscFromBlock, scanBep20, scanTrc20 } from "../lib/deposits.js";
import { CFG } from "../lib/chain.js";

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e.message); process.exitCode = 1; } };

const T0 = Date.parse("2026-11-17T10:00:00Z");
const ADDR = "0x1111111111111111111111111111111111111111";
const TADDR = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const inv = (id, amt, o = {}) => ({ id, chain: "BEP20", plan_code: "pro", expected_amount: amt, receiving_address: ADDR,
  created_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 30 * 60000).toISOString(), ...o });
const units = (s, d = 18) => { const [w, f = ""] = s.split("."); return BigInt(w + f.padEnd(d, "0").slice(0, d)); };

await t("matchTransfer: exact amount inside window", () => {
  const r = matchTransfer([inv("a", "1.003456")], { to: ADDR, units: units("1.003456"), tsMs: T0 + 5 * 60000 }, 18);
  assert.equal(r?.id, "a");
});
await t("matchTransfer: wrong amount (base price / off by 1 micro) is rejected", () => {
  assert.equal(matchTransfer([inv("a", "1.003456")], { to: ADDR, units: units("1.000000"), tsMs: T0 + 60000 }, 18), null);
  assert.equal(matchTransfer([inv("a", "1.003456")], { to: ADDR, units: units("1.003457"), tsMs: T0 + 60000 }, 18), null);
});
await t("matchTransfer: transfer before invoice / after expiry is rejected", () => {
  assert.equal(matchTransfer([inv("a", "1.003456")], { to: ADDR, units: units("1.003456"), tsMs: T0 - 10 * 60000 }, 18), null);
  assert.equal(matchTransfer([inv("a", "1.003456")], { to: ADDR, units: units("1.003456"), tsMs: T0 + 31 * 60000 }, 18), null);
});
await t("matchTransfer: same amount reused by a later invoice maps to the right one by time", () => {
  const old = inv("old", "1.003456");
  const neu = inv("new", "1.003456", { created_at: new Date(T0 + 40 * 60000).toISOString(), expires_at: new Date(T0 + 70 * 60000).toISOString() });
  assert.equal(matchTransfer([old, neu], { to: ADDR, units: units("1.003456"), tsMs: T0 + 10 * 60000 }, 18)?.id, "old");
  assert.equal(matchTransfer([old, neu], { to: ADDR, units: units("1.003456"), tsMs: T0 + 50 * 60000 }, 18)?.id, "new");
});
await t("matchTransfer: wrong recipient is rejected; TRC20 6 decimals works", () => {
  assert.equal(matchTransfer([inv("a", "1.003456")], { to: "0x2222222222222222222222222222222222222222", units: units("1.003456"), tsMs: T0 + 60000 }, 18), null);
  const tr = inv("t", "2.500123", { chain: "TRC20", receiving_address: TADDR });
  assert.equal(matchTransfer([tr], { to: TADDR, units: 2500123n, tsMs: T0 + 60000 }, 6)?.id, "t");
});
await t("bscFromBlock: covers the invoice window, capped", () => {
  const from = bscFromBlock(1_000_000, 0.75, T0, T0 + 35 * 60000);
  assert.ok(1_000_000 - from >= (35 * 60) / 0.75, "must cover 35 min of blocks");
  assert.ok(bscFromBlock(1_000_000, 0.75, T0 - 99 * 3600000, T0) >= 1_000_000 - 120000);
});

// ---- mocked network ----
const realFetch = globalThis.fetch;
const rpcReply = (method, params, st) => {
  if (method === "eth_blockNumber") return "0x" + st.latest.toString(16);
  if (method === "eth_getBlockByNumber") { const bn = parseInt(params[0], 16); return { timestamp: "0x" + Math.floor((T0 + 20 * 60000) / 1000 - (st.latest - bn) * 0.75).toString(16) }; }
  if (method === "eth_getLogs") return st.logs.filter(l => parseInt(l.blockNumber, 16) >= parseInt(params[0].fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(params[0].toBlock, 16));
  throw new Error("unexpected " + method);
};
const bscState = { latest: 50_000_000, logs: [] };
const bscLog = (tx, amt, bn, to = ADDR) => ({ transactionHash: tx, logIndex: "0x1", blockNumber: "0x" + bn.toString(16), topics: ["0xddf2", "0x" + "0".repeat(64), "0x" + to.slice(2).padStart(64, "0")], data: "0x" + units(amt).toString(16) });

await t("scanBep20: settles only the transfer that matches an open invoice (other amounts ignored)", async () => {
  bscState.logs = [bscLog("0xaaa", "1.003456", 50_000_000 - 700), bscLog("0xbbb", "9.99", 50_000_000 - 500), bscLog("0xccc", "1.003457", 50_000_000 - 300)];
  globalThis.fetch = async (_u, o) => { const b = JSON.parse(o.body); return { ok: true, json: async () => ({ result: rpcReply(b.method, b.params, bscState) }) }; };
  const out = { unmatched: 0 }; const settled = [];
  await scanBep20([inv("a", "1.003456", { created_at: new Date(T0 + 5 * 60000).toISOString(), expires_at: new Date(T0 + 35 * 60000).toISOString() })], Date.now() + 5000, out, async (i, tx) => settled.push([i.id, tx]));
  assert.deepEqual(settled, [["a", "0xaaa"]]);
});
await t("scanBep20: does not scan past the deadline", async () => {
  const settled = [];
  await scanBep20([inv("a", "1.003456")], Date.now() - 1, { unmatched: 0 }, async (i, tx) => settled.push(tx));
  assert.equal(settled.length, 0);
});
await t("scanTrc20: matches by amount + time, ignores other contract / other recipient", async () => {
  const rows = [
    { transaction_id: "tx1", value: "2500123", block_timestamp: T0 + 60000, to: TADDR, type: "Transfer", token_info: { address: CFG.TRC20.contract } },
    { transaction_id: "tx2", value: "2500123", block_timestamp: T0 + 60000, to: TADDR, type: "Transfer", token_info: { address: "TOtherToken" } },
    { transaction_id: "tx3", value: "2500123", block_timestamp: T0 + 60000, to: "TSomeoneElse", type: "Transfer", token_info: { address: CFG.TRC20.contract } },
    { transaction_id: "tx4", value: "2500000", block_timestamp: T0 + 60000, to: TADDR, type: "Transfer", token_info: { address: CFG.TRC20.contract } }
  ];
  let url = "";
  globalThis.fetch = async u => { url = String(u); return { ok: true, json: async () => ({ data: rows }) }; };
  const settled = [];
  await scanTrc20([inv("t", "2.500123", { chain: "TRC20", receiving_address: TADDR })], Date.now() + 5000, { unmatched: 0 }, async (i, tx) => settled.push([i.id, tx]));
  assert.deepEqual(settled, [["t", "tx1"]]);
  assert.ok(url.includes("only_to=true") && url.includes("only_confirmed=true") && url.includes(CFG.TRC20.contract));
});

globalThis.fetch = realFetch;
console.log(`\n${pass} passed${process.exitCode ? ", some FAILED" : ""}`);
