// Token Security Scanner, server side. The scan itself runs here so the daily limit cannot be bypassed from the browser.
// Free plan: FREE_SCANS_PER_DAY (default 25) per UTC day, then MBC Points "Token Scanner credits" are used. Paid plans: unlimited.
// Routes: GET /api/scanner/quota, POST /api/scanner/scan {network, address}. Table is created automatically on first use.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { planOf } from "./plans.js";
import { FREE_SCANS_PER_DAY } from "./entitle.js";

const GP = { ethereum: "1", bsc: "56", polygon: "137", arbitrum: "42161", base: "8453", optimism: "10", avalanche: "43114", tron: "tron" };
const EVM = ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche"];
const NETS = [...EVM, "tron", "solana", "ton"];
function validAddress(a, n) {
  if (EVM.includes(n)) return /^0x[a-fA-F0-9]{40}$/.test(a);
  if (n === "tron") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (n === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (n === "ton") return /^(0:[a-fA-F0-9]{64}|EQ[A-Za-z0-9_-]{46,50}|UQ[A-Za-z0-9_-]{46,50})$/.test(a);
  return false;
}

let schemaP = null;
function ensureSchema() {
  if (!schemaP) schemaP = db().query(`CREATE TABLE IF NOT EXISTS scanner_usage (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day DATE NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))`)
    .catch(e => { schemaP = null; throw e; });
  return schemaP;
}
const TODAY = `(NOW() AT TIME ZONE 'UTC')::date`;

async function credits(uid) {
  try { const r = await db().query(`SELECT COALESCE(SUM(remaining),0)::int AS n FROM points_boosts WHERE user_id=$1 AND resource='scanner_credits' AND remaining>0 AND expires_at>NOW()`, [uid]); return r.rows[0].n; }
  catch { return 0; }   // points tables not migrated => no credits
}
async function usedToday(uid) {
  const r = await db().query(`SELECT used FROM scanner_usage WHERE user_id=$1 AND day=${TODAY}`, [uid]); return r.rows[0]?.used || 0;
}
async function quota(uid) {
  await ensureSchema();
  const [plan, used, cr] = await Promise.all([planOf(uid), usedToday(uid), credits(uid)]);
  const unlimited = plan !== "free";
  return { plan, unlimited, freeLimit: FREE_SCANS_PER_DAY, used, remaining: unlimited ? null : Math.max(FREE_SCANS_PER_DAY - used, 0), credits: cr };
}

// Takes one scan: paid = unlimited (still counted), free = daily allowance first, then a Scanner credit. Atomic under concurrent requests.
async function take(uid, unlimited) {
  if (unlimited) { await db().query(`INSERT INTO scanner_usage (user_id, day, used) VALUES ($1, ${TODAY}, 1) ON CONFLICT (user_id, day) DO UPDATE SET used = scanner_usage.used + 1`, [uid]); return { kind: "plan" }; }
  const d = await db().query(`INSERT INTO scanner_usage (user_id, day, used) VALUES ($1, ${TODAY}, 1) ON CONFLICT (user_id, day) DO UPDATE SET used = scanner_usage.used + 1 WHERE scanner_usage.used < $2 RETURNING used`, [uid, FREE_SCANS_PER_DAY]);
  if (d.rowCount) return { kind: "daily" };
  try {
    const c = await db().query(`UPDATE points_boosts SET remaining=remaining-1 WHERE id=(SELECT id FROM points_boosts WHERE user_id=$1 AND resource='scanner_credits' AND remaining>0 AND expires_at>NOW() ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`, [uid]);
    if (c.rowCount) return { kind: "credit", id: c.rows[0].id };
  } catch { /* no points tables */ }
  return null;
}
async function giveBack(uid, t) {   // upstream failed: the user must not lose a scan
  try {
    if (t.kind === "credit") await db().query(`UPDATE points_boosts SET remaining=remaining+1 WHERE id=$1 AND remaining < amount`, [t.id]);
    else await db().query(`UPDATE scanner_usage SET used=GREATEST(used-1,0) WHERE user_id=$1 AND day=${TODAY}`, [uid]);
  } catch { /* best-effort */ }
}

async function getJ(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export async function scannerApi(req, res, path) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  try {
    if (path === "/api/scanner/quota") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      return send(res, 200, { ok: true, ...(await quota(s.id)) });
    }
    if (path === "/api/scanner/scan") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      if (rateLimited(req, res, "scan", s.id, 20)) return;
      const net = String(req.body?.network || "").toLowerCase(), addr = String(req.body?.address || "").trim();
      if (!NETS.includes(net) || !validAddress(addr, net)) return send(res, 400, { ok: false, error: "INVALID_ADDRESS" });
      await ensureSchema();
      const unlimited = (await planOf(s.id)) !== "free";
      const t = await take(s.id, unlimited);
      if (!t) return send(res, 429, { ok: false, error: "SCAN_LIMIT", freeLimit: FREE_SCANS_PER_DAY, credits: 0, hint: "Redeem Token Scanner credits with MBC Points, or upgrade your plan." });
      const a = EVM.includes(net) ? addr.toLowerCase() : addr;
      let secP;
      if (GP[net]) secP = getJ(`https://api.gopluslabs.io/api/v1/token_security/${GP[net]}?contract_addresses=${encodeURIComponent(a)}`);
      else if (net === "solana") secP = getJ(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(a)}`);
      else secP = getJ(`https://tonapi.io/v2/jettons/${encodeURIComponent(a)}`);
      const mktP = getJ(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`);
      const [sec, mkt] = await Promise.allSettled([secP, mktP]);
      if (sec.status !== "fulfilled" && mkt.status !== "fulfilled") { await giveBack(s.id, t); return send(res, 502, { ok: false, error: "UPSTREAM_UNAVAILABLE" }); }
      const m = mkt.status === "fulfilled" ? { ...mkt.value, pairs: (mkt.value?.pairs || []).slice(0, 30) } : null;
      return send(res, 200, { ok: true, sec: sec.status === "fulfilled" ? sec.value : null, mkt: m, usedFrom: t.kind, quota: await quota(s.id) });
    }
    return send(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
  } catch { return send(res, 500, { ok: false, error: "SCANNER_FAILED" }); }
}
