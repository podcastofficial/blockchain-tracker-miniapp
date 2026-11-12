// Alert history: every triggered price alert + every on-chain event (wallet / whale / contract) in one feed.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";

const KINDS = ["price", "wallet", "whale", "contract"];

export async function historyRows(uid, { kind = "all", days = 0, limit = 30, offset = 0 } = {}) {
  const k = KINDS.includes(kind) ? kind : null;
  const d = [0, 1, 7, 30, 90].includes(Number(days)) ? Number(days) : 0;
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 5000);
  const off = Math.max(Number(offset) || 0, 0);
  const r = await db().query(
    `SELECT kind, network, summary, usd, delivery_status, at FROM (
       SELECT 'price'::text AS kind, NULL::text AS network,
              a.symbol || ' went ' || a.direction || ' $' || a.target_price::float8::text
                || COALESCE(' (now $' || a.triggered_price::float8::text || ')', '') AS summary,
              a.triggered_price::float8 AS usd,
              CASE WHEN a.delivery_error IS NULL THEN 'sent' WHEN a.delivery_error = 'MUTED' THEN 'muted' ELSE 'failed' END AS delivery_status,
              a.triggered_at AS at
         FROM price_alerts a WHERE a.user_id=$1 AND a.status='triggered' AND a.triggered_at IS NOT NULL
       UNION ALL
       SELECT e.kind, e.network, e.summary, e.usd::float8, e.delivery_status, e.created_at AS at
         FROM alert_events e WHERE e.user_id=$1
     ) h
     WHERE ($2::text IS NULL OR h.kind=$2) AND ($3::int=0 OR h.at > NOW() - make_interval(days => $3::int))
     ORDER BY h.at DESC LIMIT $4 OFFSET $5`,
    [uid, k, d, lim + 1, off]);
  return { rows: r.rows.slice(0, lim), more: r.rows.length > lim };
}

export async function alertHistory(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "hist", s.id, 40)) return;
  const q = new URL(req.url, "https://x.invalid").searchParams;
  try {
    const [h, st] = await Promise.all([
      historyRows(s.id, { kind: q.get("kind") || "all", days: q.get("days"), limit: Math.min(Number(q.get("limit")) || 30, 100), offset: q.get("offset") }),
      db().query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE delivery_status='sent')::int AS sent,
                COUNT(*) FILTER (WHERE delivery_status='failed')::int AS failed,
                COUNT(*) FILTER (WHERE delivery_status='muted')::int AS muted
         FROM (
           SELECT CASE WHEN delivery_error IS NULL THEN 'sent' WHEN delivery_error='MUTED' THEN 'muted' ELSE 'failed' END AS delivery_status
             FROM price_alerts WHERE user_id=$1 AND status='triggered'
           UNION ALL SELECT delivery_status FROM alert_events WHERE user_id=$1
         ) x`, [s.id])
    ]);
    return send(res, 200, { ok: true, items: h.rows, more: h.more, stats: st.rows[0] });
  } catch { return send(res, 500, { ok: false, error: "HISTORY_FAILED" }); }
}
