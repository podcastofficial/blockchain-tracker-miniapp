import crypto from "node:crypto";
import { db } from "../lib/db.js";
import { send, methodNotAllowed } from "../lib/http.js";
import { verifyTelegramInitData } from "../lib/telegram.js";
import { createSession, readSession } from "../lib/session.js";

const RECEIVERS = {
  BEP20: () => process.env.USDT_BEP20_RECEIVE_ADDRESS,
  TRC20: () => process.env.USDT_TRC20_RECEIVE_ADDRESS
};

function pathOf(req) {
  const raw = req.url || "/";
  return new URL(raw, "https://internal.invalid").pathname.replace(/\/+$/, "") || "/";
}
function requireMethod(req, res, method) {
  if (req.method !== method) {
    methodNotAllowed(res, [method]);
    return false;
  }
  return true;
}

async function telegramLogin(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  try {
    const telegramUser = verifyTelegramInitData(req.body?.initData);
    const result = await db().query(
      `INSERT INTO users
        (telegram_user_id, username, first_name, last_name, language_code, is_premium, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         username=EXCLUDED.username, first_name=EXCLUDED.first_name,
         last_name=EXCLUDED.last_name, language_code=EXCLUDED.language_code,
         is_premium=EXCLUDED.is_premium, updated_at=NOW(), last_login_at=NOW()
       RETURNING id, telegram_user_id, username, first_name, is_blocked`,
      [String(telegramUser.id), telegramUser.username || null,
       telegramUser.first_name || null, telegramUser.last_name || null,
       telegramUser.language_code || null, Boolean(telegramUser.is_premium)]
    );
    const user = result.rows[0];
    if (user.is_blocked) return send(res, 403, { ok: false, error: "ACCOUNT_BLOCKED" });
    const token = createSession(user);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Set-Cookie", `bt_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Number(process.env.SESSION_TTL_SECONDS || 604800)}`);
    return send(res, 200, { ok: true, user });
  } catch (error) {
    const known = [
      "INVALID_INIT_DATA", "INVALID_INIT_DATA_HASH", "TELEGRAM_SIGNATURE_INVALID",
      "TELEGRAM_INIT_DATA_EXPIRED", "TELEGRAM_USER_MISSING", "TELEGRAM_USER_INVALID"
    ];
    const status = known.includes(error.message) ? 401 : 500;
    return send(res, status, { ok: false, error: status === 401 ? error.message : "AUTHENTICATION_FAILED" });
  }
}

async function me(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  try {
    const result = await db().query(
      `SELECT id, telegram_user_id, username, first_name, last_name, created_at
       FROM users WHERE id=$1 AND is_blocked=FALSE`,
      [session.id]
    );
    if (!result.rowCount) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
    return send(res, 200, { ok: true, user: result.rows[0] });
  } catch {
    return send(res, 500, { ok: false, error: "DATABASE_ERROR" });
  }
}

async function plans(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  try {
    const result = await db().query(
      `SELECT code, name, price_usdt, duration_days, features
       FROM subscription_plans WHERE is_active=TRUE
       ORDER BY CASE code WHEN 'free' THEN 0 WHEN 'pro' THEN 1 WHEN 'business' THEN 2 ELSE 3 END`
    );
    return send(res, 200, { ok: true, currency: "USDT", plans: result.rows });
  } catch {
    return send(res, 500, { ok: false, error: "DATABASE_ERROR" });
  }
}

async function createPayment(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });

  const planCode = String(req.body?.planCode || "").toLowerCase();
  const chain = String(req.body?.chain || "").toUpperCase();
  if (!["pro", "business"].includes(planCode) || !["BEP20", "TRC20"].includes(chain)) {
    return send(res, 400, { ok: false, error: "INVALID_PLAN_OR_CHAIN" });
  }
  const receivingAddress = RECEIVERS[chain]();
  if (!receivingAddress) return send(res, 503, { ok: false, error: `${chain}_RECEIVING_ADDRESS_NOT_CONFIGURED` });

  try {
    const pool = db();
    const plan = await pool.query(
      "SELECT code, price_usdt FROM subscription_plans WHERE code=$1 AND is_active=TRUE",
      [planCode]
    );
    if (!plan.rowCount || Number(plan.rows[0].price_usdt) <= 0) {
      return send(res, 404, { ok: false, error: "PLAN_NOT_AVAILABLE" });
    }
    const paymentId = crypto.randomUUID();
    const amount = plan.rows[0].price_usdt;
    await pool.query(
      `INSERT INTO subscription_payments
       (id,user_id,plan_code,chain,expected_amount,receiving_address,status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [paymentId, session.id, planCode, chain, amount, receivingAddress]
    );
    return send(res, 201, {
      ok: true,
      payment: {
        id: paymentId, planCode, chain, token: "USDT",
        amount: String(amount), receivingAddress, status: "pending",
        instructions: "Send the exact USDT amount on the selected network, then submit the transaction hash for server-side verification."
      }
    });
  } catch {
    return send(res, 500, { ok: false, error: "PAYMENT_CREATION_FAILED" });
  }
}

async function verifyPayment(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  const paymentId = String(req.body?.paymentId || "");
  const txHash = String(req.body?.txHash || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return send(res, 400, { ok: false, error: "INVALID_PAYMENT_ID" });

  try {
    const result = await db().query(
      `SELECT id, chain, status FROM subscription_payments WHERE id=$1 AND user_id=$2`,
      [paymentId, session.id]
    );
    if (!result.rowCount) return send(res, 404, { ok: false, error: "PAYMENT_NOT_FOUND" });
    const payment = result.rows[0];
    if (payment.status === "confirmed") return send(res, 200, { ok: true, status: "confirmed" });
    const patterns = { BEP20: /^0x[a-fA-F0-9]{64}$/, TRC20: /^[a-fA-F0-9]{64}$/ };
    if (!patterns[payment.chain].test(txHash)) return send(res, 400, { ok: false, error: "INVALID_TRANSACTION_HASH" });

    // Fail closed until independent chain verification is implemented and tested.
    return send(res, 503, {
      ok: false,
      error: "CHAIN_VERIFIER_NOT_IMPLEMENTED",
      message: "Payment remains pending. No subscription has been activated."
    });
  } catch {
    return send(res, 500, { ok: false, error: "PAYMENT_VERIFICATION_FAILED" });
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const path = pathOf(req);
  try {
    if (path === "/api/auth/telegram") return await telegramLogin(req, res);
    if (path === "/api/auth/me") return await me(req, res);
    if (path === "/api/subscription/plans") return await plans(req, res);
    if (path === "/api/subscription/create-payment") return await createPayment(req, res);
    if (path === "/api/subscription/verify-payment") return await verifyPayment(req, res);
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch {
    return send(res, 500, { ok: false, error: "INTERNAL_SERVER_ERROR" });
  }
}
