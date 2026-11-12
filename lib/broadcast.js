// Admin extras: broadcast message to users (queued, sent by the worker) + CSV exports delivered to the admin's Telegram chat.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { tgCall, sendText, sendDocument } from "./notify.js";
import { toCsv } from "./csv.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAID = `EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_id=u.id AND s.status='active' AND s.plan_code<>'free' AND (s.expires_at IS NULL OR s.expires_at > NOW()))`;
const AUDIENCE = { all: "TRUE", paid: PAID, free: `NOT ${PAID}` };

// Worker: sends queued broadcast messages (~25 per second, stops on Telegram rate-limit or when the time budget is used).
export async function processBroadcasts(budgetMs = 12000) {
  const t0 = Date.now();
  let sent = 0, failed = 0;
  await db().query(`UPDATE broadcast_queue SET status='queued', picked_at=NULL WHERE status='sending' AND picked_at < NOW() - INTERVAL '10 minutes'`);
  while (Date.now() - t0 < budgetMs) {
    const batch = (await db().query(
      `WITH n AS (SELECT id FROM broadcast_queue WHERE status='queued' ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
       UPDATE broadcast_queue q SET status='sending', picked_at=NOW() FROM n WHERE q.id=n.id
       RETURNING q.id, q.broadcast_id, q.telegram_user_id`)).rows;
    if (!batch.length) break;
    const texts = new Map((await db().query(`SELECT id, text FROM broadcasts WHERE id = ANY($1::bigint[])`,
      [[...new Set(batch.map(b => b.broadcast_id))]])).rows.map(r => [String(r.id), r.text]));
    let retryAfter = 0;
    const res = await Promise.all(batch.map(async b => {
      const r = await tgCall("sendMessage", { chat_id: b.telegram_user_id, text: texts.get(String(b.broadcast_id)) || "", disable_web_page_preview: true });
      if (r.status === 429) retryAfter = Math.max(retryAfter, r.retryAfter || 1);
      return { b, r };
    }));
    const ok = [], bad = [], back = [], per = new Map();
    for (const { b, r } of res) {
      if (r.status === 429) { back.push(b.id); continue; }
      (r.ok ? ok : bad).push(b.id);
      const p = per.get(String(b.broadcast_id)) || { s: 0, f: 0 }; r.ok ? p.s++ : p.f++; per.set(String(b.broadcast_id), p);
    }
    if (ok.length) await db().query(`UPDATE broadcast_queue SET status='sent' WHERE id = ANY($1::bigint[])`, [ok]);
    if (bad.length) await db().query(`UPDATE broadcast_queue SET status='failed' WHERE id = ANY($1::bigint[])`, [bad]);
    if (back.length) await db().query(`UPDATE broadcast_queue SET status='queued', picked_at=NULL WHERE id = ANY($1::bigint[])`, [back]);
    for (const [id, p] of per) await db().query(`UPDATE broadcasts SET sent=sent+$2, failed=failed+$3 WHERE id=$1`, [id, p.s, p.f]);
    sent += ok.length; failed += bad.length;
    if (retryAfter) break;
    await sleep(1000);
  }
  await db().query(`UPDATE broadcasts b SET status='done' WHERE status='sending' AND NOT EXISTS (SELECT 1 FROM broadcast_queue q WHERE q.broadcast_id=b.id AND q.status IN ('queued','sending'))`);
  return { sent, failed };
}

// Returns true when the path was handled.
export async function adminExtras(req, res, path, s, audit) {
  if (path === "/api/admin/broadcast") {
    if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return true; }
    const text = String(req.body?.text ?? "").trim(), aud = String(req.body?.audience || "");
    if (!text || text.length > 3500) { send(res, 400, { ok: false, error: "INVALID_TEXT" }); return true; }
    if (aud === "test") {
      const ok = await sendText(s.telegram_user_id, text);
      send(res, ok ? 200 : 502, { ok, test: true, error: ok ? undefined : "TELEGRAM_DELIVERY_FAILED" }); return true;
    }
    if (!AUDIENCE[aud]) { send(res, 400, { ok: false, error: "INVALID_AUDIENCE" }); return true; }
    const active = await db().query(`SELECT 1 FROM broadcasts WHERE status='sending' LIMIT 1`);
    if (active.rowCount) { send(res, 409, { ok: false, error: "BROADCAST_IN_PROGRESS" }); return true; }
    const b = await db().query(`INSERT INTO broadcasts (admin_user_id, text, audience) VALUES ($1,$2,$3) RETURNING id`, [s.id, text, aud]);
    const q = await db().query(
      `INSERT INTO broadcast_queue (broadcast_id, telegram_user_id)
       SELECT $1, u.telegram_user_id FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id
       WHERE NOT u.is_blocked AND COALESCE(p.notify_news, TRUE) AND ${AUDIENCE[aud]}`, [b.rows[0].id]);
    await db().query(`UPDATE broadcasts SET total=$2, status=CASE WHEN $2=0 THEN 'done' ELSE status END WHERE id=$1`, [b.rows[0].id, q.rowCount]);
    await audit(s.id, "admin.broadcast", "broadcast", b.rows[0].id, { audience: aud, recipients: q.rowCount });
    processBroadcasts(5000).catch(() => {}); // start right away; the 5-minute worker finishes the rest
    send(res, 200, { ok: true, id: b.rows[0].id, recipients: q.rowCount }); return true;
  }
  if (path === "/api/admin/broadcasts") {
    if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return true; }
    const r = await db().query(`SELECT id, LEFT(text, 140) AS text, audience, status, total, sent, failed, created_at FROM broadcasts ORDER BY id DESC LIMIT 10`);
    send(res, 200, { ok: true, broadcasts: r.rows }); return true;
  }
  if (path === "/api/admin/export") {
    if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return true; }
    const type = req.body?.type;
    let name, csv;
    if (type === "payments") {
      const r = await db().query(
        `SELECT p.created_at, u.telegram_user_id, u.username, p.plan_code, p.chain, p.expected_amount::float8 AS amount, p.status, p.tx_hash, p.confirmed_at, p.failure_reason
         FROM subscription_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 5000`);
      name = "payments"; csv = toCsv(["created_at", "telegram_id", "username", "plan", "chain", "amount_usdt", "status", "tx_hash", "confirmed_at", "failure_reason"],
        r.rows.map(x => [x.created_at, x.telegram_user_id, x.username, x.plan_code, x.chain, x.amount, x.status, x.tx_hash, x.confirmed_at, x.failure_reason]));
    } else if (type === "users") {
      const r = await db().query(
        `SELECT u.id, u.telegram_user_id, u.username, u.first_name, u.is_blocked, u.created_at, u.last_login_at,
                COALESCE((SELECT plan_code FROM user_subscriptions s WHERE s.user_id=u.id AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at > NOW()) ORDER BY s.expires_at DESC NULLS FIRST LIMIT 1),'free') AS plan
         FROM users u ORDER BY u.id DESC LIMIT 20000`);
      name = "users"; csv = toCsv(["id", "telegram_id", "username", "first_name", "blocked", "plan", "joined", "last_login"],
        r.rows.map(x => [x.id, x.telegram_user_id, x.username, x.first_name, x.is_blocked, x.plan, x.created_at, x.last_login_at]));
    } else { send(res, 400, { ok: false, error: "INVALID_EXPORT_TYPE" }); return true; }
    const ok = await sendDocument(s.telegram_user_id, `${name}-${new Date().toISOString().slice(0, 10)}.csv`, csv, `Admin export: ${name}`);
    if (ok) await audit(s.id, "admin.export", "export", name, {});
    send(res, ok ? 200 : 502, { ok, error: ok ? undefined : "TELEGRAM_DELIVERY_FAILED" }); return true;
  }
  return false;
}
