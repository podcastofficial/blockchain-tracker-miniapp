// MBC Points HTTP API (Phase 5/6). Mounted from api/index.js: if (path.startsWith("/api/points")) return pointsApi(req, res, path).
// Every user route requires a verified session; the user id always comes from the session, never from the request body.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import * as P from "./points.js";

const isAdmin = s => String(process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(x => x.trim()).filter(Boolean).includes(String(s.telegram_user_id));
const fail = (res, r) => {
  const code = { UNKNOWN_TASK: 400, UNKNOWN_REWARD: 400, INVALID_POINTS: 400, TASK_NOT_COMPLETED: 409, ALREADY_CLAIMED: 409, DAILY_CAP_REACHED: 409, INSUFFICIENT_POINTS: 409,
    BOOST_LIMIT_REACHED: 409, PAYMENT_IN_PROGRESS: 409, NOT_FOUND: 404, PLAN_NOT_ELIGIBLE: 422, PLAN_NOT_AVAILABLE: 404, POINTS_DISABLED: 503 }[r.error] || 422;
  return send(res, code, { ok: false, ...r });
};
const body = req => (req.body && typeof req.body === "object" ? req.body : {});
const idemOf = req => String(req.headers["idempotency-key"] || body(req).key || "").trim().slice(0, 80) || null;

export async function pointsApi(req, res, path) {
  const route = path.replace(/^\/api\/points/, "") || "/";
  try {
    // Server-to-server ad callback: authenticated by HMAC, not by a user session.
    if (route === "/ad-callback") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const b = body(req), r = await P.creditAd({ telegramId: b.telegramId, eventId: b.eventId, ts: b.ts, sig: b.sig });
      return send(res, r.status || 200, r.ok ? { ok: true, duplicate: !!r.duplicate, awarded: r.awarded || 0 } : { ok: false, error: r.error });
    }
    const s = readSession(req);
    if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
    if (rateLimited(req, res, "points", s.id, 60)) return;
    const u = await db().query(`SELECT is_blocked FROM users WHERE id=$1`, [s.id]);
    if (!u.rowCount || u.rows[0].is_blocked) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
    const q = new URL(req.url, "https://x.invalid").searchParams;

    if (route === "/") { if (req.method !== "GET") return methodNotAllowed(res, ["GET"]); return send(res, 200, await P.summary(s.id)); }
    if (route === "/tasks") { if (req.method !== "GET") return methodNotAllowed(res, ["GET"]); return send(res, 200, await P.tasks(s.id)); }
    if (route === "/history") { if (req.method !== "GET") return methodNotAllowed(res, ["GET"]); const b = Number(q.get("before")); return send(res, 200, await P.history(s.id, Number(q.get("limit")) || 50, Number.isSafeInteger(b) && b > 0 ? b : null)); }
    if (route === "/rewards") { if (req.method !== "GET") return methodNotAllowed(res, ["GET"]); return send(res, 200, await P.catalog()); }

    if (route === "/claim") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (rateLimited(req, res, "points-claim", s.id, 10)) return;
      const r = await P.claimDaily(s.id, String(body(req).task || ""));
      return r.ok ? send(res, 200, r) : fail(res, r);
    }
    if (route === "/redeem") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (rateLimited(req, res, "points-redeem", s.id, 10)) return;
      const r = await P.redeemBoost(s.id, String(body(req).reward || ""), idemOf(req));
      return r.ok ? send(res, 200, r) : fail(res, r);
    }
    if (route.startsWith("/discount/")) {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (rateLimited(req, res, "points-discount", s.id, 20)) return;
      const b = body(req), plan = String(b.planCode || "").toLowerCase();
      if (route === "/discount/quote") { const r = await P.quoteDiscount(s.id, plan); return r.ok ? send(res, 200, r) : fail(res, r); }
      if (route === "/discount/reserve") { const r = await P.reserveDiscount(s.id, plan, Number(b.points), idemOf(req)); return r.ok ? send(res, 201, r) : fail(res, r); }
      if (route === "/discount/release") { const r = await P.releaseDiscount(s.id, String(b.redemptionId || "")); return r.ok ? send(res, 200, r) : fail(res, r); }
      if (route === "/discount/confirm") {   // read-only status check; the deduction itself happens inside the payment-confirmation transaction
        const r = await db().query(`SELECT r.id, r.status, r.points, r.final_price, p.status AS payment_status FROM points_redemptions r LEFT JOIN subscription_payments p ON p.id=r.payment_id WHERE r.id=$1 AND r.user_id=$2 AND r.kind='discount'`, [String(b.redemptionId || ""), s.id]);
        if (!r.rowCount) return send(res, 404, { ok: false, error: "NOT_FOUND" });
        return send(res, 200, { ok: true, redemptionId: r.rows[0].id, status: r.rows[0].status, paymentStatus: r.rows[0].payment_status || null, points: r.rows[0].points });
      }
    }

    if (route.startsWith("/admin/")) {
      if (!isAdmin(s)) return send(res, 403, { ok: false, error: "FORBIDDEN" });
      if (route === "/admin/settings") {
        if (req.method === "GET") return send(res, 200, { ok: true, config: await P.getConfig(true), defaults: P.DEFAULTS });
        if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
        const v = P.validateConfigPatch(body(req).config);
        if (v.error) return send(res, 400, { ok: false, error: "INVALID_CONFIG", field: v.error });
        const cur = (await db().query(`SELECT value FROM points_settings WHERE key='config'`)).rows[0]?.value || {};
        const next = JSON.parse(JSON.stringify(cur));
        const deep = (a, b) => { for (const [k, x] of Object.entries(b)) a[k] = x && typeof x === "object" && !Array.isArray(x) ? deep(a[k] && typeof a[k] === "object" ? a[k] : {}, x) : x; return a; };
        deep(next, v.value);
        await db().query(`INSERT INTO points_settings (key, value, updated_by) VALUES ('config',$1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [JSON.stringify(next), s.id]);
        await db().query(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,'points.settings','config','config',$2)`, [s.id, JSON.stringify({ before: cur, patch: v.value })]);
        P.resetConfigCache();
        return send(res, 200, { ok: true, config: await P.getConfig(true) });
      }
      if (route === "/admin/user") {
        if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
        const t = await db().query(`SELECT id FROM users WHERE telegram_user_id=$1`, [String(q.get("telegramId") || "")]);
        if (!t.rowCount) return send(res, 404, { ok: false, error: "USER_NOT_FOUND" });
        return send(res, 200, { ...(await P.summary(Number(t.rows[0].id))), ...(await P.history(Number(t.rows[0].id), 50)) });
      }
      if (route === "/admin/adjust") {
        if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
        const b = body(req), t = await db().query(`SELECT id FROM users WHERE telegram_user_id=$1`, [String(b.telegramId || "")]);
        if (!t.rowCount) return send(res, 404, { ok: false, error: "USER_NOT_FOUND" });
        const r = await P.adminAdjust(s.id, Number(t.rows[0].id), Number(b.delta), b.reason);
        return r.ok ? send(res, 200, r) : fail(res, r);
      }
      if (route === "/admin/reverse") {
        if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
        const r = await P.reverseEntry(s.id, Number(body(req).ledgerId), body(req).reason);
        return r.ok ? send(res, 200, r) : fail(res, r);
      }
      if (route === "/admin/reconcile") { if (req.method !== "GET") return methodNotAllowed(res, ["GET"]); return send(res, 200, await P.reconcile()); }
    }
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    console.error("POINTS_API_ERROR", route, e && e.message);
    return send(res, 500, { ok: false, error: "POINTS_FAILED" });
  }
}
