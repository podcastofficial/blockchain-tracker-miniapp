// Browser login without Telegram initData: the bot (/login) issues a one-time code, the web page exchanges it for a session.
import crypto from "node:crypto";
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { createSession } from "./session.js";
import { rateLimited, clientKey } from "./ratelimit.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/1/I/L/O
const TTL_MIN = 5;
const hash = c => crypto.createHash("sha256").update(`${process.env.APP_SESSION_SECRET || ""}:login:${c}`).digest("hex");
const maxAge = () => Number(process.env.SESSION_TTL_SECONDS || 604800);

function newCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
export const prettyCode = c => c.slice(0, 4) + "-" + c.slice(4);

// Called by the bot. Returns the code, or null when the user asked for too many in the last hour.
export async function issueLoginCode(from) {
  const tg = Number(from?.id);
  if (!Number.isSafeInteger(tg)) return null;
  const n = await db().query(`SELECT COUNT(*)::int AS n FROM login_codes WHERE telegram_user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [tg]);
  if (n.rows[0].n >= 5) return null;
  await db().query(`UPDATE login_codes SET used_at=NOW() WHERE telegram_user_id=$1 AND used_at IS NULL`, [tg]);
  const code = newCode();
  await db().query(
    `INSERT INTO login_codes (telegram_user_id, username, first_name, code_hash, expires_at) VALUES ($1,$2,$3,$4, NOW() + ($5 || ' minutes')::interval)`,
    [tg, from.username || null, from.first_name || null, hash(code), String(TTL_MIN)]);
  return code;
}

export async function codeLogin(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (rateLimited(req, res, "codelogin", clientKey(req), 10)) return;
  const code = String(req.body?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) return send(res, 400, { ok: false, error: "INVALID_CODE" });
  try {
    const c = await db().query(
      `UPDATE login_codes SET used_at=NOW() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING telegram_user_id, username, first_name`, [hash(code)]);
    if (!c.rowCount) return send(res, 401, { ok: false, error: "INVALID_OR_EXPIRED_CODE" });
    const t = c.rows[0];
    const r = await db().query(
      `INSERT INTO users (telegram_user_id, username, first_name, last_login_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (telegram_user_id) DO UPDATE SET username=COALESCE(EXCLUDED.username, users.username),
         first_name=COALESCE(EXCLUDED.first_name, users.first_name), last_login_at=NOW(), updated_at=NOW()
       RETURNING id, telegram_user_id, username, first_name, is_blocked`, [t.telegram_user_id, t.username, t.first_name]);
    const user = r.rows[0];
    if (user.is_blocked) return send(res, 403, { ok: false, error: "ACCOUNT_BLOCKED" });
    res.setHeader("Set-Cookie", `bt_session=${createSession(user)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge()}`);
    return send(res, 200, { ok: true, user });
  } catch { return send(res, 500, { ok: false, error: "AUTHENTICATION_FAILED" }); }
}

export async function logout(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  res.setHeader("Set-Cookie", "bt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return send(res, 200, { ok: true });
}
