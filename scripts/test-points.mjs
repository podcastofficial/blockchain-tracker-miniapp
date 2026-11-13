// Run: node scripts/test-points.mjs   (needs `npm install` for pg; DB is stubbed, no network)
process.env.DATABASE_URL = "postgres://localhost/x"; process.env.APP_SESSION_SECRET = "x".repeat(40); process.env.ADMIN_TELEGRAM_IDS = "900";
import pg from "pg"; import assert from "node:assert/strict";
const { createSession } = await import("../lib/session.js");
const P = await import("../lib/points.js");
const { pointsApi } = await import("../lib/points_api.js");
let pass = 0; const t = (name, fn) => (async () => fn())().then(() => { pass++; console.log("ok  ", name); }, e => { console.error("FAIL", name, "\n", e); process.exitCode = 1; });

await t("discount: tiers respect the 20% ceiling", () => {
  assert.deepEqual(P.allowedPoints(1), []);                       // $1 plan: 20% = $0.20 < smallest tier $0.50
  assert.deepEqual(P.allowedPoints(2.5), [500]);                  // $0.50 = exactly 20%
  assert.deepEqual(P.allowedPoints(5), [500, 1000]);
  assert.deepEqual(P.allowedPoints(25), [500, 1000, 2500, 5000]);
});
await t("discount: exact math, cap and bad input", () => {
  const q = P.computeDiscount(5, 1000); assert.equal(q.ok, true); assert.equal(q.discount, "1.000000"); assert.equal(q.final, "4.000000");
  assert.equal(P.computeDiscount(5, 2500).error, "EXCEEDS_MAX_DISCOUNT");
  assert.equal(P.computeDiscount(5, 700).error, "POINTS_NOT_OFFERED");
  for (const bad of [0, -5, 1.5, NaN]) assert.equal(P.computeDiscount(5, bad).ok, false);
  assert.equal(P.computeDiscount(0, 500).ok, false);
});
await t("discount: flex mode steps up to the cap only", () => {
  const cfg = { ...P.DEFAULTS.discount, flex: true };
  assert.deepEqual(P.allowedPoints(1, cfg), [100, 200]);
  assert.equal(P.computeDiscount(1, 300, cfg).ok, false);
});
await t("discount: min final price and hard 20% ceiling cannot be bypassed", () => {
  assert.equal(P.computeDiscount(2.5, 500, { ...P.DEFAULTS.discount, minFinalUsd: 2.2 }).ok, false);
  assert.equal(P.computeDiscount(5, 2500, { ...P.DEFAULTS.discount, maxPct: 90 }).ok, false);
});
await t("config patch validation", () => {
  assert.ok(P.validateConfigPatch({ dailyCap: 80 }).value);
  assert.ok(P.validateConfigPatch({ discount: { maxPct: 25 } }).error);
  assert.ok(P.validateConfigPatch({ rewards: { hacked: { points: 1 } } }).error);
  assert.ok(P.validateConfigPatch({ rewards: { daily_login: { points: -1 } } }).error);
  assert.ok(P.validateConfigPatch({}).error);
});
await t("referral can never be capped", () => {
  assert.ok(P.validateConfigPatch({ rewards: { referral: { capped: true } } }).error);
  assert.ok(P.validateConfigPatch({ rewards: { referral: { dailyMax: 3 } } }).error);
  assert.ok(P.validateConfigPatch({ rewards: { referral: { points: 60 } } }).value);
  assert.equal(P.DEFAULTS.rewards.referral.capped, false);
  assert.equal(P.DEFAULTS.rewards.referral.dailyMax, undefined);
});
await t("ad signature: valid, tampered, replayed-late, wrong secret", () => {
  const now = Date.now(), ts = Math.floor(now / 1000), sig = P.adSignature("s3cret", "111", "evt_123456", ts);
  assert.equal(P.verifyAdSignature("s3cret", "111", "evt_123456", ts, sig, now), true);
  assert.equal(P.verifyAdSignature("s3cret", "222", "evt_123456", ts, sig, now), false);
  assert.equal(P.verifyAdSignature("other", "111", "evt_123456", ts, sig, now), false);
  assert.equal(P.verifyAdSignature("s3cret", "111", "evt_123456", ts, sig, now + 3600e3), false);
  assert.equal(P.verifyAdSignature("s3cret", "111", "evt_123456", ts, "zz", now), false);
});

// API authorization with a stubbed pool
const calls = []; pg.Pool.prototype.query = async function (sql, p = []) { calls.push(sql); if (/is_blocked FROM users/.test(sql)) return { rows: [{ is_blocked: false }], rowCount: 1 }; return { rows: [], rowCount: 0 }; };
const mk = (method, url, body, session) => { const req = { method, url, headers: session ? { authorization: "Bearer " + createSession(session) } : {}, body, socket: {} }; const res = { code: 0, out: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.out = o; return this; } }; return [req, res]; };
const call = async (...a) => { const [req, res] = mk(...a); await pointsApi(req, res, new URL(req.url, "https://x").pathname); return res; };
await t("api: anonymous is rejected, ad callback needs a valid signature", async () => {
  assert.equal((await call("GET", "/api/points")).code, 401);
  assert.equal((await call("POST", "/api/points/claim", { task: "daily_login" })).code, 401);
  assert.equal((await call("POST", "/api/points/ad-callback", { telegramId: "1", eventId: "evt_123456", ts: 1, sig: "00" })).code, 503);   // no POINTS_AD_SECRET
  process.env.POINTS_AD_SECRET = "k"; assert.equal((await call("POST", "/api/points/ad-callback", { telegramId: "1", eventId: "evt_123456", ts: 1, sig: "00" })).code, 401);
});
await t("api: non-admin cannot reach admin routes; admin validation rejects bad config", async () => {
  const user = { id: 5, telegram_user_id: "111" }, admin = { id: 1, telegram_user_id: "900" };
  assert.equal((await call("POST", "/api/points/admin/adjust", { telegramId: "1", delta: 100, reason: "test reason" }, user)).code, 403);
  assert.equal((await call("POST", "/api/points/admin/settings", { config: { discount: { maxPct: 50 } } }, admin)).code, 400);
});
await t("api: a client-supplied user id or discount is ignored (routes only read session + plan/points)", async () => {
  calls.length = 0; await call("POST", "/api/points/discount/quote", { planCode: "pro", userId: 999, discount: 9 }, { id: 5, telegram_user_id: "111" });
  assert.ok(!calls.some(s => /999/.test(s)));
});
console.log(`\n${pass} passed${process.exitCode ? " — FAILURES ABOVE" : ""}`);
