// Phantom deeplink relay. Lets a user connect / sign in the Phantom APP (outside Telegram) and come back to the Mini App.
//   GET  /api/phantom/config        where to send the user back to (Telegram link) after Phantom
//   POST /api/phantom/relay         phantom-return.html drops Phantom's ENCRYPTED answer here (keyed by a random sid)
//   GET  /api/phantom/relay?sid=    the Mini App picks the answer up once (it is deleted on read)
// Only ciphertext is stored: it can be opened only with the secret key that never leaves the user's own device,
// so the server (and anybody who sees the sid) learns nothing. Rows expire after 15 minutes.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { rateLimited, clientKey } from "./ratelimit.js";

const SID_RE = /^[a-f0-9]{32}$/;
const B58 = max => new RegExp("^[1-9A-HJ-NP-Za-km-z]{1," + max + "}$");
const PUB_RE = B58(64), NONCE_RE = B58(64), DATA_RE = B58(8000);
const KINDS = ["connect", "sign"];

let schemaP = null;
function ensureSchema() {
  if (!schemaP) schemaP = db().query(
    `CREATE TABLE IF NOT EXISTS phantom_relay (sid TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  ).catch(e => { schemaP = null; throw e; });
  return schemaP;
}

function tgLink() {
  const full = String(process.env.TG_MINIAPP_LINK || "").trim();
  if (/^https:\/\/t\.me\/[A-Za-z0-9_]{4,}(\/[A-Za-z0-9_]+)?(\?.*)?$/.test(full)) return full;
  const bot = String(process.env.BOT_USERNAME || "").replace(/^@/, ""), short = String(process.env.MINIAPP_SHORT_NAME || "");
  if (/^[A-Za-z0-9_]{4,}$/.test(bot)) return short && /^[A-Za-z0-9_]+$/.test(short) ? `https://t.me/${bot}/${short}` : `https://t.me/${bot}`;
  return null;
}

async function put(req, res) {
  if (rateLimited(req, res, "ph-put", clientKey(req), 30)) return;
  const b = req.body || {};
  const sid = String(b.sid || ""), kind = String(b.kind || "");
  if (!SID_RE.test(sid) || !KINDS.includes(kind)) return send(res, 400, { ok: false, error: "INVALID_INPUT" });
  const p = { kind };
  if (b.errorCode || b.errorMessage) {
    p.errorCode = String(b.errorCode || "").replace(/[^0-9-]/g, "").slice(0, 8);
    p.errorMessage = String(b.errorMessage || "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 200);
  } else {
    const data = String(b.data || ""), nonce = String(b.nonce || ""), pub = String(b.phantom_encryption_public_key || "");
    if (!DATA_RE.test(data) || !NONCE_RE.test(nonce) || (pub && !PUB_RE.test(pub))) return send(res, 400, { ok: false, error: "INVALID_INPUT" });
    p.data = data; p.nonce = nonce; if (pub) p.phantom_encryption_public_key = pub;
  }
  await ensureSchema();
  await db().query(`DELETE FROM phantom_relay WHERE created_at < NOW() - INTERVAL '15 minutes'`);
  await db().query(
    `INSERT INTO phantom_relay (sid, payload) VALUES ($1, $2) ON CONFLICT (sid) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [sid, JSON.stringify(p)]);
  return send(res, 200, { ok: true });
}

async function take(req, res) {
  if (rateLimited(req, res, "ph-get", clientKey(req), 120)) return;
  const sid = new URL(req.url, "https://x").searchParams.get("sid") || "";
  if (!SID_RE.test(sid)) return send(res, 400, { ok: false, error: "INVALID_INPUT" });
  await ensureSchema();
  const { rows } = await db().query(
    `DELETE FROM phantom_relay WHERE sid = $1 AND created_at > NOW() - INTERVAL '15 minutes' RETURNING payload`, [sid]);
  return send(res, 200, rows[0] ? { ok: true, ready: true, result: rows[0].payload } : { ok: true, ready: false });
}

export async function phantomApi(req, res, path) {
  try {
    if (path === "/api/phantom/config") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      return send(res, 200, { ok: true, tgLink: tgLink() });
    }
    if (path === "/api/phantom/relay") {
      if (req.method === "POST") return await put(req, res);
      if (req.method === "GET") return await take(req, res);
      return methodNotAllowed(res, ["GET", "POST"]);
    }
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch (e) {
    console.error("PHANTOM_RELAY_ERROR", path, e && e.message);
    return send(res, 500, { ok: false, error: "RELAY_FAILED" });
  }
}
