import crypto from "node:crypto";
import { getBearer } from "./http.js";

function secret() {
  const value = process.env.APP_SESSION_SECRET || "";
  if (Buffer.byteLength(value) < 32) throw new Error("APP_SESSION_SECRET_TOO_SHORT");
  return value;
}
function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}
export function createSession(user) {
  const ttl = Number(process.env.SESSION_TTL_SECONDS || 604800);
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id),
    tg: String(user.telegram_user_id),
    exp: Math.floor(Date.now() / 1000) + ttl
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
export function readSession(req) {
  const token = getBearer(req) || req.cookies?.bt_session || null;
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.sub || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: Number(data.sub), telegram_user_id: data.tg };
  } catch {
    return null;
  }
}
