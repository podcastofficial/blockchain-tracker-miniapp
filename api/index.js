
import crypto from "node:crypto";
import { db } from "../lib/db.js";
import { send, methodNotAllowed, getBearer } from "../lib/http.js";
import { verifyTelegramInitData } from "../lib/telegram.js";
import { createSession, readSession } from "../lib/session.js";
import { verifyOnChain } from "../lib/chain.js";
import { portfolioBalances, portfolioHistory } from "../lib/portfolio.js";
import { onchainAlerts, cronOnchain, contractActivity } from "../lib/onchain_alerts.js";
import { networkStatus } from "../lib/netstatus.js";
import { marketOverview, whaleFeed, coinProxy } from "../lib/market.js";
import { rateLimited, clientKey } from "../lib/ratelimit.js";
import { limitsFor } from "../lib/plans.js";
import { watchlist } from "../lib/watchlist.js";
import { adminApi } from "../lib/admin.js";
import { defiOverview } from "../lib/defi.js";
import { txHistory } from "../lib/txhistory.js";
import { multiChainOverview } from "../lib/multichain.js";
import { telegramWebhook } from "../lib/bot.js";
import { cronChannels } from "../lib/channels.js";
import { dexApi } from "../lib/dex.js";
import { launchApi } from "../lib/launchpad.js";
import { profile } from "../lib/profile.js";
import { codeLogin, logout } from "../lib/loginCode.js";
import { referral, attachReferral } from "../lib/referral.js";
import { alertHistory } from "../lib/history.js";
import { exportApi } from "../lib/export.js";
import { confirmPayment } from "../lib/payments.js";
import { runMaintenance } from "../lib/maintenance.js";

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
  if (rateLimited(req, res, "login", clientKey(req), 20)) return;

  try {
    const telegramUser = verifyTelegramInitData(req.body?.initData);

    const result = await db().query(
      `INSERT INTO users
        (telegram_user_id, username, first_name, last_name, language_code, is_premium, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         username=EXCLUDED.username,
         first_name=EXCLUDED.first_name,
         last_name=EXCLUDED.last_name,
         language_code=EXCLUDED.language_code,
         is_premium=EXCLUDED.is_premium,
         updated_at=NOW(),
         last_login_at=NOW()
       RETURNING id, telegram_user_id, username, first_name, is_blocked, (xmax = 0) AS inserted`,
      [
        String(telegramUser.id),
        telegramUser.username || null,
        telegramUser.first_name || null,
        telegramUser.last_name || null,
        telegramUser.language_code || null,
        Boolean(telegramUser.is_premium)
      ]
    );

    const { inserted, ...user } = result.rows[0];

    if (user.is_blocked) {
      return send(res, 403, { ok: false, error: "ACCOUNT_BLOCKED" });
    }

    // New user that arrived through a referral link: start_param is part of the signed initData.
    if (inserted) {
      try { await attachReferral(user.id, new URLSearchParams(req.body.initData).get("start_param")); } catch { /* referral is best-effort */ }
    }

    const token = createSession(user);

    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Set-Cookie",
      `bt_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Number(process.env.SESSION_TTL_SECONDS || 604800)}`
    );

    return send(res, 200, { ok: true, user });
  } catch (error) {
    const known = [
      "INVALID_INIT_DATA",
      "INVALID_INIT_DATA_HASH",
      "TELEGRAM_SIGNATURE_INVALID",
      "TELEGRAM_INIT_DATA_EXPIRED",
      "TELEGRAM_USER_MISSING",
      "TELEGRAM_USER_INVALID"
    ];

    const status = known.includes(error.message) ? 401 : 500;

    return send(res, status, {
      ok: false,
      error: status === 401 ? error.message : "AUTHENTICATION_FAILED"
    });
  }
}

async function me(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const session = readSession(req);

  if (!session) {
    return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  }

  try {
    const result = await db().query(
      `SELECT id, telegram_user_id, username, first_name, last_name, created_at
       FROM users
       WHERE id=$1 AND is_blocked=FALSE`,
      [session.id]
    );

    if (!result.rowCount) {
      return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
    }

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
       FROM subscription_plans
       WHERE is_active=TRUE
       ORDER BY CASE code
         WHEN 'free' THEN 0
         WHEN 'pro' THEN 1
         WHEN 'business' THEN 2
         ELSE 3
       END`
    );

    return send(res, 200, {
      ok: true,
      currency: "USDT",
      plans: result.rows
    });
  } catch {
    return send(res, 500, { ok: false, error: "DATABASE_ERROR" });
  }
}

async function subscriptionMe(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const session = readSession(req);

  if (!session) {
    return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  }

  try {
    const result = await db().query(
      `SELECT
         s.id,
         s.plan_code,
         s.status,
         s.starts_at,
         s.expires_at,
         p.name,
         p.price_usdt,
         p.duration_days,
         p.features
       FROM user_subscriptions s
       JOIN subscription_plans p ON p.code=s.plan_code
       WHERE s.user_id=$1
         AND s.status='active'
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY s.starts_at DESC NULLS LAST, s.id DESC
       LIMIT 1`,
      [session.id]
    );

    if (!result.rowCount) {
      return send(res, 200, {
        ok: true,
        subscription: {
          plan: {
            code: "free",
            name: "Free",
            price_usdt: "0",
            duration_days: null,
            features: [
              "Basic wallet watchlist",
              "Limited alerts"
            ]
          },
          status: "active",
          starts_at: null,
          expires_at: null
        }
      });
    }

    const row = result.rows[0];

    return send(res, 200, {
      ok: true,
      subscription: {
        id: row.id,
        status: row.status,
        starts_at: row.starts_at,
        expires_at: row.expires_at,
        plan: {
          code: row.plan_code,
          name: row.name,
          price_usdt: row.price_usdt,
          duration_days: row.duration_days,
          features: row.features
        }
      }
    });
  } catch {
    return send(res, 500, {
      ok: false,
      error: "SUBSCRIPTION_LOOKUP_FAILED"
    });
  }
}

async function createPayment(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const session = readSession(req);

  if (!session) {
    return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  }

  if (rateLimited(req, res, "pay-create", session.id, 6)) return;
  const planCode = String(req.body?.planCode || "").toLowerCase();
  const chain = String(req.body?.chain || "").toUpperCase();

  if (
    !["pro", "business"].includes(planCode) ||
    !["BEP20", "TRC20"].includes(chain)
  ) {
    return send(res, 400, {
      ok: false,
      error: "INVALID_PLAN_OR_CHAIN"
    });
  }

  const receivingAddress = RECEIVERS[chain]();

  if (!receivingAddress) {
    return send(res, 503, {
      ok: false,
      error: `${chain}_RECEIVING_ADDRESS_NOT_CONFIGURED`
    });
  }

  const validReceiver = chain === "BEP20"
    ? /^0x[a-fA-F0-9]{40}$/.test(receivingAddress)
    : /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(receivingAddress);

  if (!validReceiver) {
    return send(res, 503, {
      ok: false,
      error: `${chain}_RECEIVING_ADDRESS_INVALID`
    });
  }

  const client = await db().connect();

  try {
    const plan = await client.query(
      `SELECT code, price_usdt
       FROM subscription_plans
       WHERE code=$1 AND is_active=TRUE`,
      [planCode]
    );

    if (!plan.rowCount || Number(plan.rows[0].price_usdt) <= 0) {
      return send(res, 404, {
        ok: false,
        error: "PLAN_NOT_AVAILABLE"
      });
    }

    // Lock invoice allocation per chain.
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [`subscription-invoice:${chain}`]
    );

    try {
      // FIXED:
      // USDT supports 6 decimal places.
      // Pro: 1.000001 to 1.009999
      // Business: 2.500001 to 2.509999
      // Enterprise: 5.000001 to 5.009999

      const base = Math.round(
        Number(plan.rows[0].price_usdt) * 1_000_000
      );

      let invoiceAmount = null;

      for (let attempt = 0; attempt < 30; attempt++) {
        const suffix = crypto.randomInt(1, 10000);

        const candidate = (base + suffix) / 1_000_000;
        const candidateAmount = candidate.toFixed(6);

        const exists = await client.query(
          `SELECT 1
           FROM subscription_payments
           WHERE chain=$1
             AND expected_amount=$2
             AND status IN ('pending','verifying')
             AND created_at > NOW() - INTERVAL '35 minutes'
           LIMIT 1`,
          [chain, candidateAmount]
        );

        if (!exists.rowCount) {
          invoiceAmount = candidateAmount;
          break;
        }
      }

      if (!invoiceAmount) {
        return send(res, 503, {
          ok: false,
          error: "INVOICE_ALLOCATION_BUSY"
        });
      }

      const paymentId = crypto.randomUUID();

      const inserted = await client.query(
        `INSERT INTO subscription_payments
         (
           id,
           user_id,
           plan_code,
           chain,
           expected_amount,
           receiving_address,
           status,
           expires_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW()+INTERVAL '30 minutes')
         RETURNING id, expected_amount, receiving_address, expires_at`,
        [
          paymentId,
          session.id,
          planCode,
          chain,
          invoiceAmount,
          receivingAddress
        ]
      );

      const row = inserted.rows[0];

      return send(res, 201, {
        ok: true,
        payment: {
          id: row.id,
          planCode,
          chain,
          token: "USDT",
          baseAmount: String(plan.rows[0].price_usdt),
          amount: row.expected_amount,
          receivingAddress: row.receiving_address,
          status: "pending",
          expiresAt: row.expires_at,
          instructions:
            "Send the exact invoice amount using USDT on the selected network. Do not send the base plan price; the invoice amount includes a unique micro-amount suffix. After sending, paste the transaction hash to verify."
        }
      });
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [`subscription-invoice:${chain}`]
      );
    }
  } catch {
    return send(res, 500, {
      ok: false,
      error: "PAYMENT_CREATION_FAILED"
    });
  } finally {
    client.release();
  }
}

async function verifyPayment(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const session = readSession(req);

  if (!session) {
    return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  }

  if (rateLimited(req, res, "pay-verify", session.id, 12)) return;
  const paymentId = String(req.body?.paymentId || "");
  const txHash = String(req.body?.txHash || "").trim();

  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) {
    return send(res, 400, {
      ok: false,
      error: "INVALID_PAYMENT_ID"
    });
  }

  try {
    const result = await db().query(
      `SELECT id, chain, status, plan_code, expected_amount, receiving_address, created_at, expires_at
       FROM subscription_payments
       WHERE id=$1 AND user_id=$2`,
      [paymentId, session.id]
    );

    if (!result.rowCount) {
      return send(res, 404, {
        ok: false,
        error: "PAYMENT_NOT_FOUND"
      });
    }

    const payment = result.rows[0];

    if (payment.status === "confirmed") {
      return send(res, 200, {
        ok: true,
        status: "confirmed"
      });
    }

    const patterns = {
      BEP20: /^0x[a-fA-F0-9]{64}$/,
      TRC20: /^[a-fA-F0-9]{64}$/
    };

    if (!patterns[payment.chain].test(txHash)) {
      return send(res, 400, {
        ok: false,
        error: "INVALID_TRANSACTION_HASH"
      });
    }

    if (payment.status === "rejected" || payment.status === "expired") {
      return send(res, 409, { ok: false, error: "PAYMENT_CLOSED", status: payment.status });
    }
    if (new Date(payment.expires_at) < new Date()) {
      await db().query("UPDATE subscription_payments SET status='expired', updated_at=NOW() WHERE id=$1 AND status<>'confirmed'", [payment.id]);
      return send(res, 410, { ok: false, error: "PAYMENT_EXPIRED" });
    }

    // Each tx hash can be used only once, across all users.
    const used = await db().query(
      "SELECT 1 FROM subscription_payments WHERE chain=$1 AND lower(tx_hash)=lower($2) AND id<>$3",
      [payment.chain, txHash, payment.id]
    );
    if (used.rowCount) {
      return send(res, 409, { ok: false, error: "TX_ALREADY_USED" });
    }

    let v;
    try {
      v = await verifyOnChain(payment.chain, txHash, payment);
    } catch {
      return send(res, 502, { ok: false, error: "CHAIN_PROVIDER_UNAVAILABLE", message: "Try again in a minute." });
    }

    if (v.state === "pending") {
      // Remember the hash so the 5-minute worker can finish the verification without the user tapping Verify again.
      await db().query(
        `UPDATE subscription_payments SET tx_hash=$2, status='verifying', confirmations=$3, updated_at=NOW()
         WHERE id=$1 AND status IN ('pending','verifying')`,
        [payment.id, txHash, v.confirmations ?? 0]).catch(() => {});
      return send(res, 202, { ok: true, status: "verifying", reason: v.reason, confirmations: v.confirmations ?? 0 });
    }
    if (v.state === "rejected") {
      return send(res, 422, { ok: false, error: v.reason });
    }
    if (v.paidAt < new Date(payment.created_at.getTime() - 60000)) {
      return send(res, 422, { ok: false, error: "TX_BEFORE_INVOICE" });
    }

    // Confirmed on-chain: activate atomically (same code the auto-recheck worker uses; also handles referral bonus).
    try {
      await confirmPayment({ ...payment, user_id: session.id }, txHash, v.confirmations);
      return send(res, 200, { ok: true, status: "confirmed" });
    } catch (e) {
      if (e.code === "23505") return send(res, 409, { ok: false, error: "TX_ALREADY_USED" });
      throw e;
    }
  } catch {
    return send(res, 500, {
      ok: false,
      error: "PAYMENT_VERIFICATION_FAILED"
    });
  }
}

const ALERT_LIMITS = { free: 3, pro: 20, business: 100, enterprise: 500 };

async function alertLimitFor(userId) {
  const l = await limitsFor(userId);
  return { plan: l.plan, limit: l.alerts };
}

async function priceAlerts(req, res, path) {
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  const uid = session.id;
  if (req.method === "GET") {
    const [list, lim] = await Promise.all([
      db().query(`SELECT id, coin_id, symbol, direction, target_price::text AS target_price, status,
                  triggered_price::text AS triggered_price, triggered_at, created_at
                  FROM price_alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [uid]),
      alertLimitFor(uid)
    ]);
    return send(res, 200, { ok: true, alerts: list.rows, plan: lim.plan, limit: lim.limit });
  }
  if (req.method === "POST") {
    const b = req.body || {};
    const coin = String(b.coinId || "");
    const sym = String(b.symbol || "").slice(0, 12).toUpperCase();
    const dir = b.direction;
    const target = Number(b.targetPrice);
    if (!/^[a-z0-9-]{1,80}$/.test(coin) || !sym || !["above", "below"].includes(dir) || !Number.isFinite(target) || target <= 0 || target > 1e15) {
      return send(res, 400, { ok: false, error: "INVALID_ALERT" });
    }
    const lim = await alertLimitFor(uid);
    const cnt = await db().query(`SELECT ((SELECT COUNT(*) FROM price_alerts WHERE user_id=$1 AND status='active') + (SELECT COUNT(*) FROM onchain_alerts WHERE user_id=$1 AND status='active'))::int AS n`, [uid]);
    if (cnt.rows[0].n >= lim.limit) return send(res, 403, { ok: false, error: "ALERT_LIMIT_REACHED", limit: lim.limit, plan: lim.plan });
    const ins = await db().query(
      `INSERT INTO price_alerts (user_id, coin_id, symbol, direction, target_price)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [uid, coin, sym, dir, String(target)]);
    return send(res, 201, { ok: true, id: ins.rows[0].id });
  }
  if (req.method === "DELETE") {
    const id = Number(new URL(req.url, "https://x.invalid").searchParams.get("id"));
    if (!Number.isSafeInteger(id)) return send(res, 400, { ok: false, error: "INVALID_ID" });
    await db().query(`DELETE FROM price_alerts WHERE id=$1 AND user_id=$2`, [id, uid]);
    return send(res, 200, { ok: true });
  }
  return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || "";
  const given = getBearer(req) || String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Price-alert worker. Returns [httpStatus, body]; cronAlerts() sends it together with the maintenance result.
async function priceAlertsRun() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rows = (await db().query(
    `SELECT a.id, a.coin_id, a.symbol, a.direction, a.target_price::float8 AS target, u.telegram_user_id,
            COALESCE(pr.notify_price, TRUE) AS notify
     FROM price_alerts a JOIN users u ON u.id=a.user_id LEFT JOIN user_profiles pr ON pr.user_id=a.user_id
     WHERE a.status='active' AND NOT u.is_blocked LIMIT 1000`)).rows;
  if (!rows.length) return [200, { ok: true, checked: 0, triggered: 0 }];
  const ids = [...new Set(rows.map(r => r.coin_id))];
  const prices = {};
  for (let i = 0; i < ids.length; i += 200) {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=" + encodeURIComponent(ids.slice(i, i + 200).join(",")));
    if (!r.ok) return [502, { ok: false, error: "PRICE_SOURCE_UNAVAILABLE", status: r.status }];
    Object.assign(prices, await r.json());
  }
  let triggered = 0;
  const dailyAlertSent = new Map();
  for (const r of rows) {
    const p = prices[r.coin_id]?.usd;
    if (typeof p !== "number") continue;
    if (!(r.direction === "above" ? p >= r.target : p <= r.target)) continue;
    const claim = await db().query(
      `UPDATE price_alerts SET status='triggered', triggered_at=NOW(), triggered_price=$2
       WHERE id=$1 AND status='active' RETURNING id`, [r.id, String(p)]);
    if (!claim.rowCount) continue;
    triggered++;
    if (!r.notify) { // user switched price notifications off in My Profile: keep it in history as muted
      await db().query(`UPDATE price_alerts SET delivery_error='MUTED' WHERE id=$1`, [r.id]);
      continue;
    }
    if (!dailyAlertSent.has(r.telegram_user_id)) {
      const count = await db().query(
        `SELECT COUNT(*)::int AS n FROM price_alerts WHERE user_id=(SELECT id FROM users WHERE telegram_user_id=$1)
         AND triggered_at >= date_trunc('day', NOW()) AND id <> $2 AND COALESCE(delivery_error,'') <> 'MUTED'`, [r.telegram_user_id, r.id]);
      dailyAlertSent.set(r.telegram_user_id, count.rows[0].n);
    }
    const userRow = await db().query(`SELECT id FROM users WHERE telegram_user_id=$1`, [r.telegram_user_id]);
    const planLimits = userRow.rowCount ? await limitsFor(userRow.rows[0].id) : { alerts: 50 };
    if (dailyAlertSent.get(r.telegram_user_id) >= planLimits.alerts) {
      await db().query(`UPDATE price_alerts SET delivery_error='DAILY_LIMIT_REACHED' WHERE id=$1`, [r.id]);
      continue;
    }
    const fmt = n => n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(Number(n.toPrecision(4)));
    const text = `🔔 ${r.symbol} is ${r.direction === "above" ? "above" : "below"} $${fmt(r.target)}\nPrice now: $${fmt(p)}`;
    try {
      const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: r.telegram_user_id, text })
      });
      if (!t.ok) await db().query(`UPDATE price_alerts SET delivery_error=$2 WHERE id=$1`, [r.id, "TELEGRAM_" + t.status]);
      else dailyAlertSent.set(r.telegram_user_id, dailyAlertSent.get(r.telegram_user_id) + 1);
    } catch {
      await db().query(`UPDATE price_alerts SET delivery_error='TELEGRAM_UNREACHABLE' WHERE id=$1`, [r.id]);
    }
  }
  return [200, { ok: true, checked: rows.length, triggered }];
}

async function cronAlerts(req, res) {
  if (!cronAuthorized(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  const [[status, body], maintenance] = await Promise.all([priceAlertsRun(), runMaintenance()]);
  return send(res, status, { ...body, maintenance });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const path = pathOf(req);

  try {
    if (path === "/api/auth/telegram") {
      return await telegramLogin(req, res);
    }

    if (path === "/api/auth/me") {
      return await me(req, res);
    }

    if (path === "/api/portfolio/balances") return await portfolioBalances(req, res);
    if (path === "/api/portfolio/history") return await portfolioHistory(req, res);

    if (path === "/api/market/overview") return await marketOverview(req, res);
    if (path === "/api/market/whales") return await whaleFeed(req, res);
    if (path === "/api/market/coin") return await coinProxy(req, res);
    if (path === "/api/swap-config") { // public, non-secret settings for the in-app swap page
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || "", integrator: process.env.LIFI_INTEGRATOR || "" });
    }
    if (path === "/api/network/status") return await networkStatus(req, res);
    if (path === "/api/alerts/onchain") return await onchainAlerts(req, res);
    if (path === "/api/contract/activity") return await contractActivity(req, res);
    if (path === "/api/cron/onchain") return await cronOnchain(req, res);
    if (path === "/api/cron/channels") return await cronChannels(req, res);

    if (path === "/api/auth/code") return await codeLogin(req, res);
    if (path === "/api/auth/logout") return await logout(req, res);
    if (path === "/api/profile") return await profile(req, res);
    if (path === "/api/referral") return await referral(req, res);
    if (path === "/api/alerts/history") return await alertHistory(req, res);
    if (path === "/api/export") return await exportApi(req, res);
    if (path === "/api/cron/maintenance") {
      if (!cronAuthorized(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
      return send(res, 200, { ok: true, maintenance: await runMaintenance() });
    }

    if (path === "/api/watchlist") return await watchlist(req, res);
    if (path.startsWith("/api/admin/")) return await adminApi(req, res, path);
    if (path === "/api/defi/overview") return await defiOverview(req, res);
    if (path.startsWith("/api/dex/")) return await dexApi(req, res, path);
    if (path.startsWith("/api/launch/")) return await launchApi(req, res, path);
    if (path === "/api/tx/history") return await txHistory(req, res);
    if (path === "/api/wallet/multichain") return await multiChainOverview(req, res);
    if (path === "/api/telegram/webhook") return await telegramWebhook(req, res);

    if (path === "/api/alerts") {
      return await priceAlerts(req, res, path);
    }

    if (path === "/api/cron/alerts") {
      return await cronAlerts(req, res);
    }

    if (path === "/api/subscription/plans") {
      return await plans(req, res);
    }

    if (path === "/api/subscription/me") {
      return await subscriptionMe(req, res);
    }

    if (path === "/api/subscription/create-payment") {
      return await createPayment(req, res);
    }

    if (path === "/api/subscription/verify-payment") {
      return await verifyPayment(req, res);
    }

    return send(res, 404, {
      ok: false,
      error: "API_ROUTE_NOT_FOUND"
    });
  } catch (err) {
    console.error("API_ERROR", path, err && err.message);
    return send(res, 500, {
      ok: false,
      error: "INTERNAL_SERVER_ERROR"
    });
  }
}
