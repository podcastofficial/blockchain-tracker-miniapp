// Payment activation (shared by the manual "verify" button and the auto-recheck worker) + plan-expiry reminders.
import { db } from "./db.js";
import { verifyOnChain } from "./chain.js";
import { sendText, appButton } from "./notify.js";
import { rewardReferrer } from "./referral.js";
import { confirmForPayment } from "./points.js";

const tgIdOf = async uid => (await db().query(`SELECT telegram_user_id FROM users WHERE id=$1`, [uid])).rows[0]?.telegram_user_id;
const day = d => new Date(d).toISOString().slice(0, 10);

// payment needs: id, user_id, chain, plan_code, expected_amount. Throws on DB errors (23505 = tx hash already used).
export async function confirmPayment(payment, txHash, confirmations) {
  const client = await db().connect();
  let expiresAt = null, reward = null;
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT status FROM subscription_payments WHERE id=$1 FOR UPDATE", [payment.id]);
    if (lock.rows[0].status === "confirmed") { await client.query("ROLLBACK"); return { status: "already" }; }
    const plan = await client.query("SELECT duration_days FROM subscription_plans WHERE code=$1", [payment.plan_code]);
    const days = plan.rows[0].duration_days || 30;
    await client.query(
      `UPDATE subscription_payments SET status='confirmed', tx_hash=$2, confirmations=$3,
       confirmed_at=NOW(), updated_at=NOW(), failure_reason=NULL WHERE id=$1`,
      [payment.id, txHash, confirmations]);
    const sub = await client.query(
      `INSERT INTO user_subscriptions (user_id, plan_code, status, starts_at, expires_at)
       VALUES ($1,$2,'active',NOW(),
         GREATEST(NOW(), COALESCE((SELECT MAX(expires_at) FROM user_subscriptions
           WHERE user_id=$1 AND status='active' AND expires_at > NOW()), NOW())) + ($3 || ' days')::interval)
       RETURNING expires_at`,
      [payment.user_id, payment.plan_code, String(days)]);
    expiresAt = sub.rows[0].expires_at;
    await client.query(
      "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'payment.confirmed','payment',$2,$3)",
      [payment.user_id, payment.id, JSON.stringify({ chain: payment.chain, txHash, amount: payment.expected_amount })]);
    reward = await rewardReferrer(client, payment.user_id, payment.id);
    await confirmForPayment(client, payment.id);   // MBC Points: reserved -> spent, same transaction as the plan activation
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }

  // Best-effort Telegram messages after the commit.
  try {
    const me = await tgIdOf(payment.user_id);
    if (me) await sendText(me, `✅ Payment confirmed\n${String(payment.plan_code).toUpperCase()} is active until ${day(expiresAt)}.`, appButton());
    if (reward) {
      const ref = await tgIdOf(reward.referrerId);
      if (ref) await sendText(ref, `🎁 Referral bonus\nSomeone you invited just subscribed. +${reward.days} days were added to your plan.`, appButton());
    }
  } catch { /* ignore */ }
  return { status: "confirmed" };
}

// Re-checks invoices that were submitted but not yet confirmed (waiting for block confirmations), so users need not tap Verify again.
export async function recheckPayments(budgetMs = 15000) {
  const t0 = Date.now();
  await db().query(`UPDATE subscription_payments SET status='expired', updated_at=NOW() WHERE status='pending' AND expires_at < NOW()`);
  const rows = (await db().query(
    `SELECT id, user_id, chain, plan_code, expected_amount, receiving_address, created_at, expires_at, tx_hash
     FROM subscription_payments
     WHERE status='verifying' AND tx_hash IS NOT NULL AND created_at > NOW() - INTERVAL '6 hours'
     ORDER BY updated_at ASC LIMIT 20`)).rows;
  const out = { checked: rows.length, confirmed: 0, waiting: 0, reopened: 0, errors: 0 };
  const one = async p => {
    if (Date.now() - t0 > budgetMs) return;
    try {
      const v = await verifyOnChain(p.chain, p.tx_hash, p);
      if (v.state === "pending") {
        await db().query(`UPDATE subscription_payments SET confirmations=$2, updated_at=NOW() WHERE id=$1 AND status='verifying'`, [p.id, v.confirmations ?? 0]);
        out.waiting++;
      } else if (v.state === "rejected" || v.paidAt < new Date(new Date(p.created_at).getTime() - 60000)) {
        // Wrong / failed transfer: put the invoice back to "pending" so the user can submit another hash before it expires.
        await db().query(`UPDATE subscription_payments SET status='pending', tx_hash=NULL, failure_reason=$2, updated_at=NOW() WHERE id=$1 AND status='verifying'`,
          [p.id, v.state === "rejected" ? v.reason : "TX_BEFORE_INVOICE"]);
        out.reopened++;
      } else {
        const r = await confirmPayment(p, p.tx_hash, v.confirmations);
        if (r.status === "confirmed") out.confirmed++;
      }
    } catch { out.errors++; }
  };
  for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(one));
  return out;
}

// One reminder when a paid plan has <= 3 days left, one when <= 1 day is left (only for the user's last active period).
export async function expiryReminders() {
  const rows = (await db().query(
    `WITH c AS (
       SELECT s.id, s.plan_code, s.expires_at, u.telegram_user_id, COALESCE(p.notify_expiry, TRUE) AS notify,
              CASE WHEN s.expires_at < NOW() + INTERVAL '1 day' THEN '1d' ELSE '3d' END AS kind
         FROM user_subscriptions s
         JOIN users u ON u.id=s.user_id
         LEFT JOIN user_profiles p ON p.user_id=u.id
        WHERE s.status='active' AND s.plan_code IN ('pro','business','enterprise')
          AND s.expires_at > NOW() AND s.expires_at < NOW() + INTERVAL '3 days' AND NOT u.is_blocked
          AND s.expires_at = (SELECT MAX(x.expires_at) FROM user_subscriptions x WHERE x.user_id=s.user_id AND x.status='active'))
     SELECT * FROM c WHERE NOT EXISTS (SELECT 1 FROM expiry_reminders r WHERE r.subscription_id=c.id AND r.kind=c.kind) LIMIT 50`)).rows;
  let sent = 0, muted = 0;
  for (const r of rows) {
    const claim = await db().query(`INSERT INTO expiry_reminders (subscription_id, kind) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [r.id, r.kind]);
    if (!claim.rowCount) continue;
    if (!r.notify) { muted++; continue; }
    const left = r.kind === "1d" ? "less than 24 hours" : "3 days or less";
    const ok = await sendText(r.telegram_user_id,
      `⏰ Your ${String(r.plan_code).toUpperCase()} plan ends on ${day(r.expires_at)} (${left} left).\nRenew from Subscription in the app to keep your higher alert limits.`, appButton());
    if (ok) sent++;
  }
  return { due: rows.length, sent, muted };
}
