import { db } from "./db.js";
import { boostTotals } from "./points.js";

// Launch-phase limits. Tracking limits are per user and separated by wallet/contract.
export const LIMITS = {
  wallets:             { free: 10, pro: 25, business: 50, enterprise: 100 },
  contracts:           { free: 10, pro: 25, business: 50, enterprise: 100 },
  walletNotifications: { free: 500, pro: 1500, business: 5000, enterprise: 10000 },
  contractNotifications:{ free: 500, pro: 1500, business: 5000, enterprise: 10000 },
  alerts:              { free: 50, pro: 150, business: 500, enterprise: 1000 }
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
  const b = await boostTotals(uid);                 // MBC Points boosts: temporary, additive, expire automatically
  const get = key => (LIMITS[key][plan] ?? LIMITS[key].free) + (b[key] || 0);
  return { plan, wallets: get("wallets"), contracts: get("contracts"),
    walletNotifications: get("walletNotifications"), contractNotifications: get("contractNotifications"),
    alerts: get("alerts"), watchlist: get("wallets") + get("contracts"), boosts: b };
}
