// MBC Points engine (Phase 5 + 6): ledger, rewards, daily cap, expiry, feature boosts and package-discount reservations.
// Rules: points are NOT cash, cannot be withdrawn, converted to USDT or transferred. Every balance change is one DB transaction
// holding a row lock on user_points and writing exactly one append-only ledger row with a unique idempotency key.
import crypto from "node:crypto";
import { db } from "./db.js";
import { sendText, appButton } from "./notify.js";

// ───────────────────────── configuration ─────────────────────────
export const HARD_MAX_DISCOUNT_PCT = 20;          // finalized business rule: admin settings can lower it, never raise it
export const DEFAULTS = {
  enabled: true,
  dailyCap: 100,                                  // finalized
  expiryDays: 365, warnDays: 30,                  // finalized: 365 days of inactivity
  rewards: {                                      // PROPOSED launch values, all editable
    daily_login:    { points: 5,  capped: true  },
    rewarded_ad:    { points: 10, capped: true,  dailyMax: 5 },
    first_wallet:   { points: 10, capped: false },  // one-time onboarding: outside the cap (confirm before launch)
    first_contract: { points: 10, capped: false },
    daily_task:     { points: 20, capped: true  },
    referral:       { points: 50, capped: false }  // NEVER capped: no daily cap, no per-referrer limit (finalized)
  },
  boosts: {                                       // PROPOSED catalog
    extra_wallet_slots:        { title: "+5 wallet slots",            cost: 100, resource: "wallets",               amount: 5,   days: 7,  maxActive: 3 },
    extra_contract_slots:      { title: "+5 contract slots",          cost: 100, resource: "contracts",             amount: 5,   days: 7,  maxActive: 3 },
    wallet_notifications:      { title: "+500 wallet notifications/day",   cost: 150, resource: "walletNotifications",   amount: 500, days: 7, maxActive: 3 },
    contract_notifications:    { title: "+500 contract notifications/day", cost: 150, resource: "contractNotifications", amount: 500, days: 7, maxActive: 3 },
    alert_capacity:            { title: "+25 alert capacity",         cost: 100, resource: "alerts",                amount: 25,  days: 7,  maxActive: 3 },
    scanner_credits:           { title: "10 Token Scanner scans",     cost: 100, resource: "scanner_credits",       amount: 10,  days: 30, maxActive: 5 },
    advanced_analytics:        { title: "Advanced analytics (7 days)", cost: 200, resource: "advanced_analytics",   amount: 1,   days: 7,  maxActive: 1 }
  },
  discount: {
    pointsPerUsd: 1000,                           // 100 points = $0.10 promotional value
    tiers: [500, 1000, 2500, 5000],
    flex: false, flexStep: 100,                   // flex=true also allows any multiple of flexStep up to the cap (needed for $1 plans, see notes)
    maxPct: 20, minFinalUsd: 0.5, reservationMinutes: 45,
    eligiblePlans: ["pro", "business", "enterprise"]
  }
};
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return o; };
let cfgCache = { at: 0, v: null };
export async function getConfig(force = false) {
  if (!force && cfgCache.v && Date.now() - cfgCache.at < 30000) return cfgCache.v;
  let over = {};
  try { over = (await db().query(`SELECT value FROM points_settings WHERE key='config'`)).rows[0]?.value || {}; } catch { /* table missing => defaults */ }
  const v = merge(DEFAULTS, over);
  v.discount.maxPct = Math.min(Number(v.discount.maxPct) || 0, HARD_MAX_DISCOUNT_PCT);
  v.rewards.referral = { points: v.rewards.referral.points, capped: false };   // referral income is uncapped, even if an old override says otherwise
  cfgCache = { at: Date.now(), v };
  return v;
}
export const resetConfigCache = () => { cfgCache = { at: 0, v: null }; };

// Validates an admin config patch; returns { value } (sanitised partial) or { error }.
export function validateConfigPatch(p) {
  if (!isObj(p)) return { error: "config" };
  const out = {}, int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if ("enabled" in p) { if (typeof p.enabled !== "boolean") return { error: "enabled" }; out.enabled = p.enabled; }
  if ("dailyCap" in p) { if (!int(p.dailyCap, 1, 10000)) return { error: "dailyCap" }; out.dailyCap = p.dailyCap; }
  if ("expiryDays" in p) { if (!int(p.expiryDays, 30, 3650)) return { error: "expiryDays" }; out.expiryDays = p.expiryDays; }
  if ("warnDays" in p) { if (!int(p.warnDays, 1, 180)) return { error: "warnDays" }; out.warnDays = p.warnDays; }
  if ("rewards" in p) {
    if (!isObj(p.rewards)) return { error: "rewards" }; out.rewards = {};
    for (const [k, r] of Object.entries(p.rewards)) {
      if (!DEFAULTS.rewards[k] || !isObj(r)) return { error: "rewards." + k };
      const o = {};
      if (k === "referral" && ("capped" in r || "dailyMax" in r)) return { error: "rewards.referral.uncapped" };   // referral can never be capped
      if ("points" in r) { if (!int(r.points, 0, 1000)) return { error: `rewards.${k}.points` }; o.points = r.points; }
      if ("capped" in r) { if (typeof r.capped !== "boolean") return { error: `rewards.${k}.capped` }; o.capped = r.capped; }
      if ("dailyMax" in r) { if (!int(r.dailyMax, 0, 100)) return { error: `rewards.${k}.dailyMax` }; o.dailyMax = r.dailyMax; }
      out.rewards[k] = o;
    }
  }
  if ("boosts" in p) {
    if (!isObj(p.boosts)) return { error: "boosts" }; out.boosts = {};
    for (const [k, b] of Object.entries(p.boosts)) {
      if (!DEFAULTS.boosts[k] || !isObj(b)) return { error: "boosts." + k };
      const o = {};
      for (const [f, lo, hi] of [["cost", 1, 100000], ["amount", 1, 100000], ["days", 1, 365], ["maxActive", 0, 20]])
        if (f in b) { if (!int(b[f], lo, hi)) return { error: `boosts.${k}.${f}` }; o[f] = b[f]; }
      out.boosts[k] = o;
    }
  }
  if ("discount" in p) {
    const d = p.discount; if (!isObj(d)) return { error: "discount" }; out.discount = {};
    if ("maxPct" in d) { if (!int(d.maxPct, 0, HARD_MAX_DISCOUNT_PCT)) return { error: "discount.maxPct" }; out.discount.maxPct = d.maxPct; }
    if ("pointsPerUsd" in d) { if (!int(d.pointsPerUsd, 10, 100000)) return { error: "discount.pointsPerUsd" }; out.discount.pointsPerUsd = d.pointsPerUsd; }
    if ("minFinalUsd" in d) { if (typeof d.minFinalUsd !== "number" || d.minFinalUsd < 0.01 || d.minFinalUsd > 1000) return { error: "discount.minFinalUsd" }; out.discount.minFinalUsd = d.minFinalUsd; }
    if ("flex" in d) { if (typeof d.flex !== "boolean") return { error: "discount.flex" }; out.discount.flex = d.flex; }
    if ("flexStep" in d) { if (!int(d.flexStep, 10, 10000)) return { error: "discount.flexStep" }; out.discount.flexStep = d.flexStep; }
    if ("reservationMinutes" in d) { if (!int(d.reservationMinutes, 5, 240)) return { error: "discount.reservationMinutes" }; out.discount.reservationMinutes = d.reservationMinutes; }
    if ("tiers" in d) { if (!Array.isArray(d.tiers) || d.tiers.length > 12 || d.tiers.some(t => !int(t, 10, 1000000))) return { error: "discount.tiers" }; out.discount.tiers = [...new Set(d.tiers)].sort((a, b) => a - b); }
    if ("eligiblePlans" in d) { if (!Array.isArray(d.eligiblePlans) || d.eligiblePlans.some(x => typeof x !== "string" || !/^[a-z0-9_-]{1,30}$/.test(x))) return { error: "discount.eligiblePlans" }; out.discount.eligiblePlans = d.eligiblePlans; }
  }
  return Object.keys(out).length ? { value: out } : { error: "empty" };
}

// ───────────────────────── pure helpers (unit-tested) ─────────────────────────
export const utcDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const micro = n => Math.round(Number(n) * 1e6);
const fmt = m => (m / 1e6).toFixed(6);

// Server-side discount math in integer micro-USD. 1 point = 1e6 / pointsPerUsd micro-USD. Never trusts client numbers.
export function computeDiscount(price, points, cfg = DEFAULTS.discount) {
  const priceM = micro(price);
  if (!Number.isInteger(points) || points <= 0) return { ok: false, error: "INVALID_POINTS" };
  if (!(priceM > 0)) return { ok: false, error: "PLAN_NOT_DISCOUNTABLE" };
  const perPointM = 1e6 / cfg.pointsPerUsd;
  const capM = Math.floor(priceM * Math.min(cfg.maxPct, HARD_MAX_DISCOUNT_PCT) / 100);
  const allowed = allowedPoints(price, cfg);
  if (!allowed.includes(points)) {
    const maxPts = Math.floor(capM / perPointM);
    return { ok: false, error: points * perPointM > capM ? "EXCEEDS_MAX_DISCOUNT" : "POINTS_NOT_OFFERED", maxPoints: maxPts, allowed };
  }
  const discM = Math.round(points * perPointM);
  const finalM = priceM - discM;
  if (finalM < micro(cfg.minFinalUsd) || finalM <= 0) return { ok: false, error: "BELOW_MINIMUM_PRICE", allowed };
  return { ok: true, points, original: fmt(priceM), discount: fmt(discM), final: fmt(finalM), maxPct: cfg.maxPct };
}
// Point amounts that are valid for a price: tiers (and optional flex steps) whose value stays under the % ceiling and min price.
export function allowedPoints(price, cfg = DEFAULTS.discount) {
  const priceM = micro(price); if (!(priceM > 0)) return [];
  const perPointM = 1e6 / cfg.pointsPerUsd;
  const capM = Math.floor(priceM * Math.min(cfg.maxPct, HARD_MAX_DISCOUNT_PCT) / 100);
  const set = new Set(cfg.tiers || []);
  if (cfg.flex) for (let p = cfg.flexStep; p * perPointM <= capM; p += cfg.flexStep) set.add(p);
  return [...set].filter(p => p * perPointM <= capM && priceM - Math.round(p * perPointM) >= micro(cfg.minFinalUsd)).sort((a, b) => a - b);
}
export function adSignature(secret, tgId, eventId, ts) { return crypto.createHmac("sha256", secret).update(`${tgId}.${eventId}.${ts}`).digest("hex"); }
export function verifyAdSignature(secret, tgId, eventId, ts, sig, now = Date.now()) {
  if (!secret || !tgId || !eventId || !/^[A-Za-z0-9_-]{6,100}$/.test(String(eventId))) return false;
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 600) return false;
  const a = Buffer.from(String(sig || ""), "hex"), b = Buffer.from(adSignature(secret, tgId, eventId, t), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ───────────────────────── transaction core ─────────────────────────
async function tx(fn) {
  const c = await db().connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
async function lockRow(c, uid) {
  await c.query(`INSERT INTO user_points (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);
  return (await c.query(`SELECT * FROM user_points WHERE user_id=$1 FOR UPDATE`, [uid])).rows[0];
}
const dayStartSql = `(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
async function earnedToday(c, uid) {
  const r = await c.query(`SELECT COALESCE(SUM(amount),0)::int AS n FROM points_ledger WHERE user_id=$1 AND kind='earn' AND counts_to_cap AND created_at >= ${dayStartSql}`, [uid]);
  return r.rows[0].n;
}
async function writeLedger(c, row, uid, kind, amount, reason, key, extra = {}) {
  const bal = row.balance + amount;
  const l = await c.query(
    `INSERT INTO points_ledger (user_id, kind, amount, balance_after, reason, counts_to_cap, idempotency_key, ref_type, ref_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [uid, kind, amount, bal, reason, !!extra.capped, key, extra.refType || null, extra.refId || null, JSON.stringify(extra.meta || {})]);
  return l.rowCount ? Number(l.rows[0].id) : null;
}

// Credits points inside an open transaction. Statuses: awarded | duplicate | cap_reached | disabled.
export async function awardTx(c, uid, { code, points, capped, key, refType, refId, meta, touch = true }, cfg) {
  if (!cfg.enabled || !(points > 0)) return { status: "disabled" };
  const row = await lockRow(c, uid);
  let grant = points;
  if (capped) {
    const remaining = cfg.dailyCap - await earnedToday(c, uid);
    if (remaining <= 0) return { status: "cap_reached", remaining: 0 };
    grant = Math.min(points, remaining);
  }
  const id = await writeLedger(c, row, uid, "earn", grant, code, key, { capped, refType, refId, meta });
  if (!id) return { status: "duplicate" };
  await c.query(`UPDATE user_points SET balance=balance+$2, total_earned=total_earned+$2, updated_at=NOW(),
                   last_qualifying_activity_at = CASE WHEN $3 THEN NOW() ELSE last_qualifying_activity_at END WHERE user_id=$1`, [uid, grant, touch]);
  return { status: "awarded", points: grant, requested: points, partial: grant < points, ledgerId: id, balance: row.balance + grant };
}
const claimRow = (c, uid, task, day, pts) => c.query(`INSERT INTO points_task_claims (user_id, task_code, claim_day, points) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`, [uid, task, day, pts]);

// ───────────────────────── earning ─────────────────────────
export async function claimDaily(uid, task) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, error: "POINTS_DISABLED" };
  const code = task === "daily_task" ? "daily_task" : task === "daily_login" ? "daily_login" : null;
  if (!code) return { ok: false, error: "UNKNOWN_TASK" };
  const rw = cfg.rewards[code], day = utcDay();
  if (code === "daily_task") {                       // server-verified: a portfolio snapshot (Sync balances) exists for today (UTC)
    const v = await db().query(`SELECT 1 FROM portfolio_snapshots WHERE user_id=$1 AND taken_at >= ${dayStartSql} LIMIT 1`, [uid]);
    if (!v.rowCount) return { ok: false, error: "TASK_NOT_COMPLETED", hint: "Open Portfolio and tap Sync balances, then claim." };
  }
  return tx(async c => {
    await c.query("SAVEPOINT sp");
    const claim = await claimRow(c, uid, code, day, rw.points);
    if (!claim.rowCount) return { ok: false, error: "ALREADY_CLAIMED" };
    const r = await awardTx(c, uid, { code, points: rw.points, capped: rw.capped, key: `${code}:${uid}:${day}`, refType: "task", refId: day }, cfg);
    if (r.status !== "awarded") { await c.query("ROLLBACK TO SAVEPOINT sp"); return { ok: false, error: r.status === "cap_reached" ? "DAILY_CAP_REACHED" : "NOT_AWARDED" }; }
    await c.query(`UPDATE points_task_claims SET ledger_id=$4 WHERE user_id=$1 AND task_code=$2 AND claim_day=$3`, [uid, code, day, r.ledgerId]);
    return { ok: true, awarded: r.points, partial: r.partial, balance: r.balance };
  });
}

// Called by wallet/contract creation AFTER the address passed validation. kind: 'wallet' | 'contract'.
export async function awardOnboarding(uid, kind, network, address) {
  const cfg = await getConfig(); if (!cfg.enabled) return { status: "disabled" };
  const code = kind === "contract" ? "first_contract" : "first_wallet", rw = cfg.rewards[code];
  const norm = String(address || "").trim(); if (!norm) return { status: "invalid" };
  const ref = `${kind}:${network}:${/^0x/i.test(norm) ? norm.toLowerCase() : norm}`;
  const res = await tx(async c => {
    const claim = await claimRow(c, uid, code, "1970-01-01", rw.points);
    if (!claim.rowCount) return { status: "already_earned" };
    try {
      await c.query("SAVEPOINT a");
      const r = await awardTx(c, uid, { code, points: rw.points, capped: rw.capped, key: `${code}:${uid}`, refType: "address", refId: ref }, cfg);
      if (r.status !== "awarded") { await c.query("ROLLBACK TO SAVEPOINT a"); throw Object.assign(new Error(r.status), { soft: r.status }); }
      return r;
    } catch (e) {
      if (e.code === "23505") { await c.query("ROLLBACK TO SAVEPOINT a"); throw Object.assign(new Error("duplicate_address"), { soft: "duplicate_address" }); }
      throw e;
    }
  }).catch(e => { if (e.soft) return { status: e.soft }; throw e; });
  if (res.status === "awarded") await qualifyReferral(uid).catch(() => {});
  return res;
}

// A referred user "qualifies" on their first validated wallet/contract. Reward goes to users.referred_by exactly once.
export async function qualifyReferral(referredId) {
  const cfg = await getConfig(); const rw = cfg.rewards.referral;
  if (!cfg.enabled || !(rw.points > 0)) return { status: "disabled" };
  const u = await db().query(`SELECT referred_by FROM users WHERE id=$1`, [referredId]);
  const ref = u.rows[0]?.referred_by; if (!ref || Number(ref) === Number(referredId)) return { status: "none" };
  return tx(async c => {
    const refUser = await c.query(`SELECT is_blocked FROM users WHERE id=$1`, [ref]);
    if (!refUser.rowCount || refUser.rows[0].is_blocked) return { status: "referrer_blocked" };
    const ins = await c.query(`INSERT INTO points_referrals (referred_id, referrer_id, status) VALUES ($1,$2,'qualified') ON CONFLICT (referred_id) DO NOTHING RETURNING 1`, [referredId, ref]);
    if (!ins.rowCount) return { status: "already_qualified" };
    return awardTx(c, Number(ref), { code: "referral", points: rw.points, capped: false, key: `referral:${referredId}`, refType: "user", refId: String(referredId) }, cfg);
  });
}

// Provider-verified rewarded ad. Signature = HMAC-SHA256(POINTS_AD_SECRET, `${telegramId}.${eventId}.${ts}`).
export async function creditAd({ telegramId, eventId, ts, sig }) {
  const secret = process.env.POINTS_AD_SECRET || "";
  if (!secret) return { ok: false, status: 503, error: "ADS_NOT_CONFIGURED" };
  if (!verifyAdSignature(secret, String(telegramId), String(eventId), ts, sig)) return { ok: false, status: 401, error: "BAD_SIGNATURE" };
  const cfg = await getConfig(); const rw = cfg.rewards.rewarded_ad;
  const u = await db().query(`SELECT id, is_blocked FROM users WHERE telegram_user_id=$1`, [telegramId]);
  if (!u.rowCount || u.rows[0].is_blocked) return { ok: false, status: 404, error: "USER_NOT_FOUND" };
  const uid = Number(u.rows[0].id);
  return tx(async c => {
    await lockRow(c, uid);
    await c.query("SAVEPOINT sp");
    const n = await c.query(`SELECT COUNT(*)::int AS n FROM points_ad_events WHERE user_id=$1 AND created_at >= ${dayStartSql}`, [uid]);
    if (n.rows[0].n >= rw.dailyMax) return { ok: false, status: 429, error: "AD_DAILY_LIMIT" };
    const ev = await c.query(`INSERT INTO points_ad_events (event_id, user_id, points) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [eventId, uid, rw.points]);
    if (!ev.rowCount) return { ok: true, status: 200, duplicate: true };
    const r = await awardTx(c, uid, { code: "rewarded_ad", points: rw.points, capped: rw.capped, key: `ad:${eventId}`, refType: "ad", refId: eventId }, cfg);
    if (r.status !== "awarded") { await c.query("ROLLBACK TO SAVEPOINT sp"); return { ok: false, status: 409, error: r.status === "cap_reached" ? "DAILY_CAP_REACHED" : "NOT_AWARDED" }; }
    return { ok: true, status: 200, awarded: r.points };
  });
}

// ───────────────────────── redeeming: feature boosts ─────────────────────────
export async function redeemBoost(uid, rewardCode, idem) {
  const cfg = await getConfig(); const b = cfg.boosts[rewardCode];
  if (!cfg.enabled) return { ok: false, error: "POINTS_DISABLED" };
  if (!b) return { ok: false, error: "UNKNOWN_REWARD" };
  const idemKey = idem ? String(idem).slice(0, 80) : null, id = crypto.randomUUID();
  try {
    return await tx(async c => {
      const row = await lockRow(c, uid);
      if (idemKey) { const ex = await c.query(`SELECT id, status FROM points_redemptions WHERE user_id=$1 AND idempotency_key=$2`, [uid, idemKey]); if (ex.rowCount) return { ok: true, duplicate: true, redemptionId: ex.rows[0].id }; }
      if (row.balance - row.reserved < b.cost) return { ok: false, error: "INSUFFICIENT_POINTS", available: row.balance - row.reserved, cost: b.cost };
      const act = await c.query(`SELECT COUNT(*)::int AS n FROM points_boosts x JOIN points_redemptions r ON r.id=x.redemption_id WHERE x.user_id=$1 AND r.reward_code=$2 AND x.expires_at > NOW()`, [uid, rewardCode]);
      if (b.maxActive && act.rows[0].n >= b.maxActive) return { ok: false, error: "BOOST_LIMIT_REACHED", maxActive: b.maxActive };
      await c.query(`INSERT INTO points_redemptions (id, user_id, kind, reward_code, points, status, idempotency_key) VALUES ($1,$2,'boost',$3,$4,'confirmed',$5)`, [id, uid, rewardCode, b.cost, idemKey]);
      const lid = await writeLedger(c, row, uid, "redeem", -b.cost, rewardCode, `redeem:${id}`, { refType: "redemption", refId: id });
      const consumable = b.resource === "scanner_credits";
      const ins = await c.query(`INSERT INTO points_boosts (user_id, redemption_id, resource, amount, remaining, expires_at) VALUES ($1,$2,$3,$4,$5, NOW() + make_interval(days => $6)) RETURNING expires_at`,
        [uid, id, b.resource, b.amount, consumable ? b.amount : null, b.days]);
      await c.query(`UPDATE user_points SET balance=balance-$2, total_redeemed=total_redeemed+$2, last_qualifying_activity_at=NOW(), updated_at=NOW() WHERE user_id=$1`, [uid, b.cost]);
      return { ok: true, redemptionId: id, ledgerId: lid, cost: b.cost, resource: b.resource, amount: b.amount, expiresAt: ins.rows[0].expires_at, balance: row.balance - b.cost };
    });
  } catch (e) { if (e.code === "23505" && idemKey) return { ok: true, duplicate: true }; throw e; }
}

// ───────────────────────── redeeming: package discounts ─────────────────────────
const planPrice = async (c, plan) => (await c.query(`SELECT price_usdt FROM subscription_plans WHERE code=$1 AND is_active=TRUE`, [plan])).rows[0]?.price_usdt;

export async function quoteDiscount(uid, planCode) {
  const cfg = await getConfig(); const d = cfg.discount;
  if (!d.eligiblePlans.includes(planCode)) return { ok: false, error: "PLAN_NOT_ELIGIBLE" };
  const price = await planPrice(db(), planCode); if (!(Number(price) > 0)) return { ok: false, error: "PLAN_NOT_AVAILABLE" };
  const bal = (await db().query(`SELECT balance, reserved FROM user_points WHERE user_id=$1`, [uid])).rows[0] || { balance: 0, reserved: 0 };
  const available = bal.balance - bal.reserved;
  const options = allowedPoints(price, d).map(p => ({ points: p, ...computeDiscount(price, p, d), affordable: p <= available }));
  return { ok: true, planCode, originalPrice: fmt(micro(price)), maxPct: d.maxPct, available, options, notice: "Points are a promotional discount, not cash or crypto. The 20% ceiling applies per package." };
}
export async function reserveDiscount(uid, planCode, points, idem) {
  const cfg = await getConfig(); const d = cfg.discount;
  if (!cfg.enabled) return { ok: false, error: "POINTS_DISABLED" };
  if (!d.eligiblePlans.includes(planCode)) return { ok: false, error: "PLAN_NOT_ELIGIBLE" };
  const idemKey = idem ? String(idem).slice(0, 80) : null, id = crypto.randomUUID();
  try {
    return await tx(async c => {
      const row = await lockRow(c, uid);
      if (idemKey) { const ex = await c.query(`SELECT * FROM points_redemptions WHERE user_id=$1 AND idempotency_key=$2`, [uid, idemKey]); if (ex.rowCount) return { ok: true, duplicate: true, ...shape(ex.rows[0]) }; }
      const price = await planPrice(c, planCode); const q = computeDiscount(price, points, d);
      if (!q.ok) return q;
      // Release this user's older, not-yet-paid reservations; refuse if one is attached to a payment still in flight.
      const open = await c.query(`SELECT id, points, payment_id FROM points_redemptions WHERE user_id=$1 AND kind='discount' AND status='reserved' FOR UPDATE`, [uid]);
      let freed = 0;
      for (const o of open.rows) {
        if (o.payment_id) { const p = await c.query(`SELECT status FROM subscription_payments WHERE id=$1`, [o.payment_id]); if (p.rows[0] && ["pending", "verifying"].includes(p.rows[0].status)) return { ok: false, error: "PAYMENT_IN_PROGRESS" }; }
        await c.query(`UPDATE points_redemptions SET status='released', updated_at=NOW() WHERE id=$1`, [o.id]); freed += o.points;
      }
      const reserved = row.reserved - freed;
      if (row.balance - reserved < points) return { ok: false, error: "INSUFFICIENT_POINTS", available: row.balance - reserved };
      await c.query(`UPDATE user_points SET reserved=$2, updated_at=NOW() WHERE user_id=$1`, [uid, reserved + points]);
      const r = await c.query(`INSERT INTO points_redemptions (id, user_id, kind, points, status, plan_code, original_price, discount_usd, final_price, idempotency_key, expires_at)
        VALUES ($1,$2,'discount',$3,'reserved',$4,$5,$6,$7,$8, NOW() + make_interval(mins => $9)) RETURNING *`,
        [id, uid, points, planCode, q.original, q.discount, q.final, idemKey, d.reservationMinutes]);
      return { ok: true, ...shape(r.rows[0]) };
    });
  } catch (e) { if (e.code === "23505") return { ok: false, error: "DUPLICATE_REQUEST" }; throw e; }
}
const shape = r => ({ redemptionId: r.id, status: r.status, planCode: r.plan_code, points: r.points, originalPrice: String(r.original_price), discount: String(r.discount_usd), finalPrice: String(r.final_price), expiresAt: r.expires_at });

export async function releaseDiscount(uid, id) {
  return tx(async c => {
    const r = await c.query(`SELECT * FROM points_redemptions WHERE id=$1 AND user_id=$2 AND kind='discount' FOR UPDATE`, [id, uid]);
    if (!r.rowCount) return { ok: false, error: "NOT_FOUND" };
    const x = r.rows[0]; if (x.status !== "reserved") return { ok: true, status: x.status };
    if (x.payment_id) { const p = await c.query(`SELECT status FROM subscription_payments WHERE id=$1`, [x.payment_id]); if (p.rows[0] && ["pending", "verifying", "confirmed"].includes(p.rows[0].status)) return { ok: false, error: "PAYMENT_IN_PROGRESS" }; }
    await lockRow(c, uid);
    await c.query(`UPDATE user_points SET reserved=GREATEST(reserved-$2,0), updated_at=NOW() WHERE user_id=$1`, [uid, x.points]);
    await c.query(`UPDATE points_redemptions SET status='released', updated_at=NOW() WHERE id=$1`, [id]);
    return { ok: true, status: "released" };
  });
}

// createPayment hook (runs on the payment's pg client, before the invoice row is inserted). Returns the discounted base price.
export async function attachReservation(client, { uid, redemptionId, planCode, paymentId }) {
  const price = await planPrice(client, planCode); if (!(Number(price) > 0)) return { ok: false, error: "PLAN_NOT_AVAILABLE" };
  const r = await client.query(
    `UPDATE points_redemptions SET payment_id=$4, expires_at = NOW() + INTERVAL '6 hours 35 minutes', updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND plan_code=$3 AND kind='discount' AND status='reserved' AND payment_id IS NULL AND expires_at > NOW()
        AND original_price = $5::numeric RETURNING final_price, points`, [redemptionId, uid, planCode, paymentId, String(price)]);
  if (!r.rowCount) return { ok: false, error: "RESERVATION_INVALID_OR_EXPIRED" };   // also covers "plan price changed since the quote"
  return { ok: true, finalPrice: Number(r.rows[0].final_price), points: r.rows[0].points };
}
// confirmPayment hook (runs inside its open transaction). Moves reserved -> spent exactly once.
export async function confirmForPayment(c, paymentId) {
  const r = await c.query(`SELECT * FROM points_redemptions WHERE payment_id=$1 FOR UPDATE`, [paymentId]);
  if (!r.rowCount || r.rows[0].status === "confirmed") return null;
  const x = r.rows[0], uid = Number(x.user_id), row = await lockRow(c, uid);
  const wasReserved = x.status === "reserved";
  const spendable = wasReserved ? row.balance : row.balance - row.reserved;
  if (spendable < x.points) {                                    // customer already paid the discounted amount; never go negative, flag for admin
    await c.query(`UPDATE points_redemptions SET status='confirmed', updated_at=NOW() WHERE id=$1`, [x.id]);
    await c.query(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'points.discount_shortfall','redemption',$2,$3)`, [uid, x.id, JSON.stringify({ points: x.points, balance: row.balance })]);
    return { shortfall: true };
  }
  await writeLedger(c, row, uid, "redeem", -x.points, "package_discount", `redeem:${x.id}`, { refType: "payment", refId: String(paymentId), meta: { plan: x.plan_code, discount: String(x.discount_usd) } });
  await c.query(`UPDATE user_points SET balance=balance-$2, reserved=GREATEST(reserved-$3,0), total_redeemed=total_redeemed+$2, last_qualifying_activity_at=NOW(), updated_at=NOW() WHERE user_id=$1`, [uid, x.points, wasReserved ? x.points : 0]);
  await c.query(`UPDATE points_redemptions SET status='confirmed', updated_at=NOW() WHERE id=$1`, [x.id]);
  return { points: x.points };
}
// Job: release reservations nobody paid. Reservations attached to a payment in flight (pending/verifying) are kept.
export async function releaseStaleReservations() {
  return tx(async c => {
    const r = await c.query(
      `SELECT x.id, x.user_id, x.points FROM points_redemptions x LEFT JOIN subscription_payments p ON p.id = x.payment_id
        WHERE x.kind='discount' AND x.status='reserved' AND (
              (x.payment_id IS NULL AND x.expires_at < NOW())
           OR (x.payment_id IS NOT NULL AND p.status IN ('expired','rejected') AND p.updated_at < NOW() - INTERVAL '10 minutes')
           OR (x.payment_id IS NOT NULL AND p.id IS NULL AND x.updated_at < NOW() - INTERVAL '15 minutes')
           OR (x.payment_id IS NOT NULL AND p.status <> 'confirmed' AND p.created_at < NOW() - INTERVAL '7 hours'))
        ORDER BY x.user_id LIMIT 200 FOR UPDATE OF x SKIP LOCKED`);
    for (const x of r.rows) {
      await lockRow(c, Number(x.user_id));
      await c.query(`UPDATE user_points SET reserved=GREATEST(reserved-$2,0), updated_at=NOW() WHERE user_id=$1`, [x.user_id, x.points]);
      await c.query(`UPDATE points_redemptions SET status='expired', updated_at=NOW() WHERE id=$1`, [x.id]);
    }
    return { released: r.rowCount };
  });
}

// ───────────────────────── entitlements (used by lib/plans.js) ─────────────────────────
const ADDITIVE = ["wallets", "contracts", "walletNotifications", "contractNotifications", "alerts"];
export async function boostTotals(uid) {
  const out = Object.fromEntries(ADDITIVE.map(k => [k, 0]));
  try {
    const r = await db().query(`SELECT resource, SUM(amount)::int AS n FROM points_boosts WHERE user_id=$1 AND starts_at <= NOW() AND expires_at > NOW() AND resource = ANY($2) GROUP BY resource`, [uid, ADDITIVE]);
    for (const x of r.rows) out[x.resource] = x.n;
  } catch { /* points tables not migrated yet => no boosts, plan limits unchanged */ }
  return out;
}
export async function hasAdvancedAnalytics(uid) {
  const r = await db().query(`SELECT 1 FROM points_boosts WHERE user_id=$1 AND resource='advanced_analytics' AND expires_at > NOW() LIMIT 1`, [uid]); return r.rowCount > 0;
}
export async function consumeScannerCredit(uid) {
  const r = await db().query(`UPDATE points_boosts SET remaining=remaining-1 WHERE id=(SELECT id FROM points_boosts WHERE user_id=$1 AND resource='scanner_credits' AND remaining>0 AND expires_at>NOW() ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING remaining`, [uid]);
  return r.rowCount > 0;
}

// ───────────────────────── reads ─────────────────────────
export async function summary(uid) {
  const cfg = await getConfig();
  const [row, today, boosts, refs] = await Promise.all([
    db().query(`SELECT * FROM user_points WHERE user_id=$1`, [uid]),
    db().query(`SELECT COALESCE(SUM(amount),0)::int AS n FROM points_ledger WHERE user_id=$1 AND kind='earn' AND counts_to_cap AND created_at >= ${dayStartSql}`, [uid]),
    db().query(`SELECT x.resource, x.amount, x.remaining, x.expires_at, r.reward_code FROM points_boosts x LEFT JOIN points_redemptions r ON r.id=x.redemption_id WHERE x.user_id=$1 AND x.expires_at > NOW() ORDER BY x.expires_at`, [uid]),
    db().query(`SELECT COUNT(*)::int AS n FROM points_referrals WHERE referrer_id=$1 AND status='qualified'`, [uid])]);
  const p = row.rows[0] || { balance: 0, reserved: 0, total_earned: 0, total_redeemed: 0, total_expired: 0, last_qualifying_activity_at: null };
  const expiresAt = p.last_qualifying_activity_at ? new Date(new Date(p.last_qualifying_activity_at).getTime() + cfg.expiryDays * 864e5) : null;
  const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 864e5) : null;
  return { ok: true, enabled: cfg.enabled, balance: p.balance, reserved: p.reserved, available: p.balance - p.reserved,
    totalEarned: Number(p.total_earned), totalRedeemed: Number(p.total_redeemed), totalExpired: Number(p.total_expired),
    daily: { cap: cfg.dailyCap, earned: today.rows[0].n, remaining: Math.max(cfg.dailyCap - today.rows[0].n, 0) },
    expiry: { days: cfg.expiryDays, at: p.balance > 0 ? expiresAt : null, daysLeft: p.balance > 0 ? daysLeft : null, warning: p.balance > 0 && daysLeft !== null && daysLeft <= cfg.warnDays },
    activeBoosts: boosts.rows, qualifiedReferrals: refs.rows[0].n,
    terms: "MBC Points are promotional. They cannot be withdrawn, converted to USDT/crypto or transferred." };
}
export async function history(uid, limit = 50, before = null) {
  const r = await db().query(`SELECT id, kind, amount, balance_after, reason, created_at FROM points_ledger WHERE user_id=$1 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $2`, [uid, Math.min(Math.max(limit, 1), 100), before]);
  return { ok: true, items: r.rows.map(x => ({ ...x, id: Number(x.id) })) };
}
export async function catalog() {
  const cfg = await getConfig();
  return { ok: true, boosts: Object.entries(cfg.boosts).map(([code, b]) => ({ code, title: b.title, cost: b.cost, resource: b.resource, amount: b.amount, days: b.days })),
    discount: { pointsPerUsd: cfg.discount.pointsPerUsd, tiers: cfg.discount.tiers, maxPct: cfg.discount.maxPct, eligiblePlans: cfg.discount.eligiblePlans } };
}
export async function tasks(uid) {
  const cfg = await getConfig(), day = utcDay();
  const [claims, once, snap, ads] = await Promise.all([
    db().query(`SELECT task_code FROM points_task_claims WHERE user_id=$1 AND claim_day=$2`, [uid, day]),
    db().query(`SELECT task_code FROM points_task_claims WHERE user_id=$1 AND claim_day='1970-01-01'`, [uid]),
    db().query(`SELECT 1 FROM portfolio_snapshots WHERE user_id=$1 AND taken_at >= ${dayStartSql} LIMIT 1`, [uid]),
    db().query(`SELECT COUNT(*)::int AS n FROM points_ad_events WHERE user_id=$1 AND created_at >= ${dayStartSql}`, [uid])]);
  const done = new Set(claims.rows.map(x => x.task_code)), onceDone = new Set(once.rows.map(x => x.task_code)), R = cfg.rewards;
  return { ok: true, tasks: [
    { code: "daily_login", points: R.daily_login.points, claimable: !done.has("daily_login"), done: done.has("daily_login"), cadence: "daily" },
    { code: "daily_task", points: R.daily_task.points, claimable: !done.has("daily_task") && snap.rowCount > 0, done: done.has("daily_task"), cadence: "daily", requirement: "Sync balances in Portfolio today" },
    { code: "rewarded_ad", points: R.rewarded_ad.points, done: ads.rows[0].n >= R.rewarded_ad.dailyMax, progress: `${ads.rows[0].n}/${R.rewarded_ad.dailyMax}`, cadence: "daily", available: !!process.env.POINTS_AD_SECRET },
    { code: "first_wallet", points: R.first_wallet.points, done: onceDone.has("first_wallet"), cadence: "once", requirement: "Add your first valid wallet alert" },
    { code: "first_contract", points: R.first_contract.points, done: onceDone.has("first_contract"), cadence: "once", requirement: "Add your first valid contract alert" },
    { code: "referral", points: R.referral.points, cadence: "per qualified referral", requirement: "A friend you invited adds their first wallet or contract" }] };
}

// ───────────────────────── admin ─────────────────────────
export async function adminAdjust(adminUid, targetUid, delta, reason) {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1e6) return { ok: false, error: "INVALID_AMOUNT" };
  if (typeof reason !== "string" || reason.trim().length < 5) return { ok: false, error: "REASON_REQUIRED" };
  return tx(async c => {
    const u = await c.query(`SELECT 1 FROM users WHERE id=$1`, [targetUid]); if (!u.rowCount) return { ok: false, error: "USER_NOT_FOUND" };
    const row = await lockRow(c, targetUid);
    if (row.balance + delta < row.reserved) return { ok: false, error: "WOULD_GO_BELOW_RESERVED" };
    const key = `admin:${crypto.randomUUID()}`;
    const lid = await writeLedger(c, row, targetUid, "admin_adjust", delta, reason.trim().slice(0, 200), key, { refType: "admin", refId: String(adminUid) });
    await c.query(`UPDATE user_points SET balance=balance+$2, total_earned=total_earned+GREATEST($2,0), updated_at=NOW() WHERE user_id=$1`, [targetUid, delta]);
    await c.query(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'points.adjust','user',$2,$3)`, [adminUid, String(targetUid), JSON.stringify({ delta, reason: reason.trim().slice(0, 200), ledgerId: lid })]);
    return { ok: true, ledgerId: lid, balance: row.balance + delta };
  });
}
// Compensating entry for a wrong earn row (never edits history). Fails if the points were already spent.
export async function reverseEntry(adminUid, ledgerId, reason) {
  if (typeof reason !== "string" || reason.trim().length < 5) return { ok: false, error: "REASON_REQUIRED" };
  return tx(async c => {
    const e = await c.query(`SELECT * FROM points_ledger WHERE id=$1`, [ledgerId]); if (!e.rowCount) return { ok: false, error: "NOT_FOUND" };
    const x = e.rows[0]; if (x.kind !== "earn") return { ok: false, error: "ONLY_EARN_ENTRIES" };
    const row = await lockRow(c, Number(x.user_id));
    if (row.balance - row.reserved < x.amount) return { ok: false, error: "ALREADY_SPENT" };
    const lid = await writeLedger(c, row, Number(x.user_id), "reverse", -x.amount, reason.trim().slice(0, 200), `reverse:${ledgerId}`, { refType: "ledger", refId: String(ledgerId) });
    if (!lid) return { ok: false, error: "ALREADY_REVERSED" };
    await c.query(`UPDATE user_points SET balance=balance-$2, updated_at=NOW() WHERE user_id=$1`, [x.user_id, x.amount]);
    await c.query(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'points.reverse','ledger',$2,$3)`, [adminUid, String(ledgerId), JSON.stringify({ reason: reason.trim().slice(0, 200) })]);
    return { ok: true, ledgerId: lid };
  });
}
export async function reconcile() {
  const r = await db().query(`SELECT p.user_id, p.balance, COALESCE(SUM(l.amount),0)::int AS ledger_sum FROM user_points p LEFT JOIN points_ledger l ON l.user_id=p.user_id
    GROUP BY p.user_id, p.balance HAVING p.balance <> COALESCE(SUM(l.amount),0) LIMIT 100`);
  return { ok: true, mismatches: r.rows };
}

// ───────────────────────── scheduled jobs (called from lib/maintenance.js) ─────────────────────────
export async function runExpiry() {
  const cfg = await getConfig(); const out = { expired: 0, points: 0, warned: 0, released: 0 };
  out.released = (await releaseStaleReservations()).released;
  const due = await db().query(`SELECT user_id FROM user_points WHERE balance - reserved > 0 AND last_qualifying_activity_at < NOW() - make_interval(days => $1) LIMIT 200`, [cfg.expiryDays]);
  for (const d of due.rows) {
    const done = await tx(async c => {
      const row = await lockRow(c, Number(d.user_id)); const amt = row.balance - row.reserved;
      if (amt <= 0 || new Date(row.last_qualifying_activity_at) > new Date(Date.now() - cfg.expiryDays * 864e5)) return null;   // activity happened meanwhile
      const lid = await writeLedger(c, row, Number(d.user_id), "expire", -amt, "inactivity", `expire:${d.user_id}:${new Date(row.last_qualifying_activity_at).getTime()}`, { refType: "expiry" });
      if (!lid) return null;
      await c.query(`UPDATE user_points SET balance=balance-$2, total_expired=total_expired+$2, updated_at=NOW() WHERE user_id=$1`, [d.user_id, amt]);
      await c.query(`INSERT INTO points_expiry_log (user_id, points, ledger_id, last_activity_at) VALUES ($1,$2,$3,$4)`, [d.user_id, amt, lid, row.last_qualifying_activity_at]);
      return amt;
    }).catch(() => null);
    if (done) { out.expired++; out.points += done; }
  }
  const warn = await db().query(
    `WITH c AS (
       SELECT p.user_id FROM user_points p JOIN users u ON u.id=p.user_id
        WHERE p.balance - p.reserved > 0 AND NOT u.is_blocked
          AND p.last_qualifying_activity_at < NOW() - make_interval(days => $1)
          AND p.last_qualifying_activity_at >= NOW() - make_interval(days => $2)
          AND (p.expiry_warned_at IS NULL OR p.expiry_warned_at < p.last_qualifying_activity_at)
        LIMIT 100 FOR UPDATE OF p SKIP LOCKED)
     UPDATE user_points p SET expiry_warned_at=NOW() FROM c, users u
      WHERE p.user_id=c.user_id AND u.id=p.user_id
      RETURNING u.telegram_user_id, p.balance, p.last_qualifying_activity_at`, [cfg.expiryDays - cfg.warnDays, cfg.expiryDays]);
  for (const w of warn.rows) {
    const at = new Date(new Date(w.last_qualifying_activity_at).getTime() + cfg.expiryDays * 864e5).toISOString().slice(0, 10);
    if (await sendText(w.telegram_user_id, `⏳ Your ${w.balance} MBC Points expire on ${at} after ${cfg.expiryDays} days without activity.\nOpen the app and claim your daily login to keep them.`, appButton())) out.warned++;
  }
  return out;
}
