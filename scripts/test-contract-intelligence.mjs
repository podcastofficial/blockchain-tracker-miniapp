import test from "node:test";
import assert from "node:assert/strict";
import { aggregateContractCallers } from "../lib/contract_intelligence.js";

const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const a = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const b = "0xcccccccccccccccccccccccccccccccccccccccc";

test("aggregates only successful direct calls to the selected contract", () => {
  const rows = [
    { from: a, to: contract, hash: "0x1", timeStamp: "100", isError: "0" },
    { from: a.toUpperCase().replace("0X", "0x"), to: contract, hash: "0x2", timeStamp: "200", isError: "0" },
    { from: b, to: contract, hash: "0x3", timeStamp: "300", isError: "1" },
    { from: contract, to: a, hash: "0x4", timeStamp: "400", isError: "0" },
    { from: b, to: "0xdddddddddddddddddddddddddddddddddddddddd", hash: "0x5", timeStamp: "500", isError: "0" }
  ];
  const out = aggregateContractCallers(rows, contract);
  assert.equal(out.length, 1);
  assert.equal(out[0].address, a);
  assert.equal(out[0].transactions, 2);
  assert.equal(out[0].firstSeen, 100000);
  assert.equal(out[0].lastSeen, 200000);
});

test("ignores invalid, zero, self and failed callers", () => {
  const out = aggregateContractCallers([
    { from: "bad", to: contract, isError: "0" },
    { from: "0x0000000000000000000000000000000000000000", to: contract, isError: "0" },
    { from: contract, to: contract, isError: "0" },
    { from: a, to: contract, isError: "1" }
  ], contract);
  assert.deepEqual(out, []);
});
