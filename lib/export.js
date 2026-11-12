// POST /api/export  { type: alerts|portfolio|watchlist|payments|custom, deliver: "telegram" | "file" }
// "telegram" sends the CSV as a document to the user's bot chat (works inside Telegram, where file downloads are unreliable);
// "file" returns the CSV text so a normal browser can save it.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { toCsv } from "./csv.js";
import { historyRows } from "./history.js";
import { sendDocument } from "./notify.js";

const stamp = () => new Date().toISOString().slice(0, 10);

async function build(uid, b) {
  switch (b.type) {
    case "alerts": {
      const h = await historyRows(uid, { limit: 5000 });
      return { name: "alert-history", csv: toCsv(["time_utc", "type", "network", "summary", "usd", "delivery"],
        h.rows.map(r => [r.at, r.kind, r.network, String(r.summary || "").replace(/\s*\n\s*/g, " | "), r.usd, r.delivery_status])) };
    }
    case "portfolio": {
      const r = await db().query(`SELECT taken_at, total_usd::float8 AS v FROM portfolio_snapshots WHERE user_id=$1 ORDER BY taken_at DESC LIMIT 5000`, [uid]);
      return { name: "portfolio-history", csv: toCsv(["time_utc", "total_value_usd"], r.rows.map(x => [x.taken_at, x.v])) };
    }
    case "watchlist": {
      const r = await db().query(`SELECT items, invested_usd::float8 AS inv FROM user_watchlists WHERE user_id=$1`, [uid]);
      const items = Array.isArray(r.rows[0]?.items) ? r.rows[0].items : [];
      return { name: "watchlist", csv: toCsv(["name", "type", "network", "address", "category", "added"], items.map(i => [i.name, i.type, i.network, i.address, i.category, i.createdAt])) };
    }
    case "payments": {
      const r = await db().query(
        `SELECT created_at, plan_code, chain, expected_amount::float8 AS amount, status, tx_hash, confirmed_at
         FROM subscription_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000`, [uid]);
      return { name: "payments", csv: toCsv(["created_at", "plan", "network", "amount_usdt", "status", "tx_hash", "confirmed_at"],
        r.rows.map(x => [x.created_at, x.plan_code, x.chain, x.amount, x.status, x.tx_hash, x.confirmed_at])) };
    }
    case "custom": { // rows prepared in the page (e.g. the Transaction Explorer table)
      const name = String(b.filename || "export").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "export";
      const header = Array.isArray(b.header) ? b.header.slice(0, 12).map(x => String(x).slice(0, 60)) : null;
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : null;
      if (!header || !rows || !header.length) return null;
      return { name, csv: toCsv(header, rows.map(r => (Array.isArray(r) ? r : []).slice(0, header.length).map(c => (c == null ? "" : String(c).slice(0, 300))))) };
    }
    default: return null;
  }
}

export async function exportApi(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "export", s.id, 6)) return;
  try {
    const out = await build(s.id, req.body || {});
    if (!out) return send(res, 400, { ok: false, error: "INVALID_EXPORT" });
    const filename = `${out.name}-${stamp()}.csv`;
    if (req.body?.deliver === "file") return send(res, 200, { ok: true, filename, csv: out.csv });
    const ok = await sendDocument(s.telegram_user_id, filename, out.csv, "Blockchain Tracker export");
    if (!ok) return send(res, 502, { ok: false, error: "TELEGRAM_DELIVERY_FAILED" });
    return send(res, 200, { ok: true, delivered: true, filename });
  } catch { return send(res, 500, { ok: false, error: "EXPORT_FAILED" }); }
}
