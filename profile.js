// /api/profile  GET = read, PUT = partial update (only the keys you send change).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { SUPPORTED, validAddr } from "./balances.js";

const DEFAULTS = { display_name: null, email: null, mobile: null, wallet_network: null, wallet_address: null,
  language: "en", notify_price: true, notify_onchain: true, notify_expiry: true, notify_news: true };

const shape = r => ({
  displayName: r.display_name, email: r.email, mobile: r.mobile,
  walletNetwork: r.wallet_network, walletAddress: r.wallet_address, language: r.language,
  notifyPrice: r.notify_price, notifyOnchain: r.notify_onchain, notifyExpiry: r.notify_expiry, notifyNews: r.notify_news
});

const bool = (v, cur) => (typeof v === "boolean" ? v : cur);

// Returns { error } or { values }
function validate(body, cur) {
  const v = { ...cur };
  if ("displayName" in body) {
    const n = String(body.displayName ?? "").replace(/\s+/g, " ").trim();
    if (n.length > 60 || /[\u0000-\u001f<>]/.test(n)) return { error: "INVALID_NAME" };
    v.display_name = n || null;
  }
  if ("email" in body) {
    const e = String(body.email ?? "").trim().toLowerCase();
    if (e && (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e))) return { error: "INVALID_EMAIL" };
    v.email = e || null;
  }
  if ("mobile" in body) {
    const m = String(body.mobile ?? "").replace(/[\s\-()]/g, "");
    if (m && !/^\+?[0-9]{7,15}$/.test(m)) return { error: "INVALID_MOBILE" };
    v.mobile = m || null;
  }
  if ("walletNetwork" in body || "walletAddress" in body) {
    const net = String("walletNetwork" in body ? body.walletNetwork : cur.wallet_network ?? "").toLowerCase().trim();
    const addr = String("walletAddress" in body ? body.walletAddress : cur.wallet_address ?? "").trim();
    if (!net && !addr) { v.wallet_network = null; v.wallet_address = null; }
    else if (!SUPPORTED.includes(net) || !validAddr(net, addr)) return { error: "INVALID_WALLET" };
    else { v.wallet_network = net; v.wallet_address = addr; }
  }
  if ("language" in body) {
    if (!["en", "hi"].includes(body.language)) return { error: "INVALID_LANGUAGE" };
    v.language = body.language;
  }
  v.notify_price = bool(body.notifyPrice, v.notify_price);
  v.notify_onchain = bool(body.notifyOnchain, v.notify_onchain);
  v.notify_expiry = bool(body.notifyExpiry, v.notify_expiry);
  v.notify_news = bool(body.notifyNews, v.notify_news);
  return { values: v };
}

export async function profile(req, res) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "profile", s.id, 30)) return;
  try {
    const cur = (await db().query(`SELECT * FROM user_profiles WHERE user_id=$1`, [s.id])).rows[0] || DEFAULTS;
    if (req.method === "GET") {
      const u = (await db().query(`SELECT username, first_name, telegram_user_id FROM users WHERE id=$1`, [s.id])).rows[0] || {};
      return send(res, 200, { ok: true, profile: shape(cur), account: { username: u.username, firstName: u.first_name, telegramId: u.telegram_user_id } });
    }
    if (req.method === "PUT") {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = validate(body, cur);
      if (out.error) return send(res, 400, { ok: false, error: out.error });
      const v = out.values;
      await db().query(
        `INSERT INTO user_profiles (user_id, display_name, email, mobile, wallet_network, wallet_address, language, notify_price, notify_onchain, notify_expiry, notify_news)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name, email=EXCLUDED.email, mobile=EXCLUDED.mobile,
           wallet_network=EXCLUDED.wallet_network, wallet_address=EXCLUDED.wallet_address, language=EXCLUDED.language,
           notify_price=EXCLUDED.notify_price, notify_onchain=EXCLUDED.notify_onchain, notify_expiry=EXCLUDED.notify_expiry,
           notify_news=EXCLUDED.notify_news, updated_at=NOW()`,
        [s.id, v.display_name, v.email, v.mobile, v.wallet_network, v.wallet_address, v.language, v.notify_price, v.notify_onchain, v.notify_expiry, v.notify_news]);
      return send(res, 200, { ok: true, profile: shape(v) });
    }
    return methodNotAllowed(res, ["GET", "PUT"]);
  } catch { return send(res, 500, { ok: false, error: "PROFILE_FAILED" }); }
}
