import assert from "node:assert/strict";
import { walletScore } from "../lib/smart_money_score.js";

const insufficient = walletScore({ summary: { closedTrades: 2, winRate: 1, realizedUsd: 999 } }, []);
assert.equal(insufficient.score, null);
assert.equal(insufficient.confidence, "insufficient_history");

const sampleTrades = Array.from({ length: 12 }, (_, i) => ({ usdValue: 100 + i * 10 }));
const adequate = walletScore({ summary: { closedTrades: 12, winRate: 0.75, realizedUsd: 180 } }, sampleTrades);
assert.ok(Number.isInteger(adequate.score));
assert.ok(adequate.score >= 0 && adequate.score <= 100);
assert.equal(adequate.confidence, "medium");

const loss = walletScore({ summary: { closedTrades: 3, winRate: 0, realizedUsd: -500 } }, sampleTrades.slice(0, 3));
assert.ok(loss.score >= 0 && loss.score <= 100);
console.log("Smart Money scoring tests passed");
