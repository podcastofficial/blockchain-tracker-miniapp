import { db } from "./db.js";
export const LIMITS = {
  alerts:   { free: 3,  pro: 20, business: 100, enterprise: 500 },
  wallets:  { free: 3,  pro: 10, business: 25,  enterprise: 50 },
  watchlist:{ free: 10, pro: 50, business: 200, enterprise: 500 }
};
export async function planOf(uid) {
  const r = await db().query(
    `SELECT plan_code FROM user_subscriptions
     WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at DESC NULLS FIRST LIMIT 1`, [uid]);
  return r.rows[0]?.plan_code || "free";
}
export async function limitsFor(uid) {
  const plan = await planOf(uid);
  return { plan, alerts: LIMITS.alerts[plan] ?? LIMITS.alerts.free, wallets: LIMITS.wallets[plan] ?? LIMITS.wallets.free,
           watchlist: LIMITS.watchlist[plan] ?? LIMITS.watchlist.free };
}
