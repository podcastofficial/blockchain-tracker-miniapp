// Referrals: each user has a code; when someone NEW opens the app through the link, they are linked to the referrer.
// The referrer gets bonus days when that person's first USDT payment is confirmed (REFERRAL_REWARD_DAYS, default 7, 0 = off).
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { deepLink } from "./rich.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REF_RE = /^ref_([A-HJ-NP-Z2-9]{8})$/;
export const rewardDays = () => { const n = Number(process.env.REFERRAL_REWARD_DAYS ?? 7); return Number.isInteger(n) ? Math.min(Math.max(n, 0), 365) : 7; };
const gen = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

export async function ensureCode(uid) {
  const cur = await db().query(`SELECT referral_code FROM users WHERE id=$1`, [uid]);
  if (cur.rows[0]?.referral_code) return cur.rows[0].referral_code;
  for (let i = 0; i < 6; i++) {
    const code = gen();
    try {
      const r = await db().query(`UPDATE users SET referral_code=$2 WHERE id=$1 AND referral_code IS NULL RETURNING referral_code`, [uid, code]);
      if (r.rowCount) return r.rows[0].referral_code;
      return (await db().query(`SELECT referral_code FROM users WHERE id=$1`, [uid])).rows[0].referral_code;
    } catch (e) { if (e.code !== "23505") throw e; }
  }
  throw new Error("REFERRAL_CODE_FAILED");
}

// Called once for a brand-new user. startParam comes from the signed Telegram initData.
export async function attachReferral(newUserId, startParam) {
  const m = REF_RE.exec(String(startParam || ""));
  if (!m) return false;
  const r = await db().query(
    `UPDATE users SET referred_by=(SELECT id FROM users WHERE referral_code=$2 AND id<>$1 AND NOT is_blocked)
     WHERE id=$1 AND referred_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE referral_code=$2 AND id<>$1 AND NOT is_blocked) RETURNING id`,
    [newUserId, m[1]]);
  return r.rowCount > 0;
}

// Runs inside the payment-confirmation transaction. Returns { referrerId, days } when a reward was granted.
export async function rewardReferrer(client, refereeId, paymentId) {
  const u = await client.query(`SELECT referred_by FROM users WHERE id=$1`, [refereeId]);
  const ref = u.rows[0]?.referred_by;
  if (!ref || Number(ref) === Number(refereeId)) return null;
  const days = rewardDays();
  const ins = await client.query(
    `INSERT INTO referral_rewards (referrer_id, referred_id, payment_id, days_granted) VALUES ($1,$2,$3,$4)
     ON CONFLICT (referred_id) DO NOTHING RETURNING id`, [ref, refereeId, paymentId, days]);
  if (!ins.rowCount || days <= 0) return null;
  const cur = await client.query(
    `SELECT plan_code FROM user_subscriptions WHERE user_id=$1 AND status='active' AND expires_at > NOW()
       AND plan_code IN ('pro','business','enterprise') ORDER BY expires_at DESC LIMIT 1`, [ref]);
  const plan = cur.rows[0]?.plan_code || "pro";
  await client.query(
    `INSERT INTO user_subscriptions (user_id, plan_code, status, starts_at, expires_at)
     VALUES ($1,$2,'active',NOW(),
       GREATEST(NOW(), COALESCE((SELECT MAX(expires_at) FROM user_subscriptions WHERE user_id=$1 AND status='active' AND expires_at > NOW()), NOW())) + ($3 || ' days')::interval)`,
    [ref, plan, String(days)]);
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'referral.reward','user',$2,$3)`,
    [refereeId, String(ref), JSON.stringify({ days, plan, paymentId })]);
  return { referrerId: Number(ref), days };
}

export async function referral(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "referral", s.id, 20)) return;
  try {
    const code = await ensureCode(s.id);
    const st = await db().query(
      `SELECT (SELECT COUNT(*) FROM users WHERE referred_by=$1)::int AS invited,
              (SELECT COUNT(*) FROM referral_rewards WHERE referrer_id=$1)::int AS rewarded,
              (SELECT COALESCE(SUM(days_granted),0) FROM referral_rewards WHERE referrer_id=$1)::int AS days`, [s.id]);
    return send(res, 200, { ok: true, code, link: deepLink("ref_" + code), rewardDays: rewardDays(), ...st.rows[0] });
  } catch { return send(res, 500, { ok: false, error: "REFERRAL_FAILED" }); }
}
