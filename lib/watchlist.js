import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { SUPPORTED, validAddr } from "./balances.js";
import { limitsFor } from "./plans.js";
import { rateLimited } from "./ratelimit.js";

function clean(items) {
  const seen = new Set(), out = [];
  for (const i of Array.isArray(items) ? items : []) {
    const type = i?.type, network = String(i?.network || "").toLowerCase(), address = String(i?.address || "").trim();
    if (!["wallet", "contract"].includes(type) || !SUPPORTED.includes(network) || !validAddr(network, address)) continue;
    const key = `${type}:${network}:${address.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      id: String(i.id || "").slice(0, 64) || key, type, network, address,
      name: String(i.name || "").slice(0, 50) || "Unnamed", category: String(i.category || "Custom").slice(0, 30),
      createdAt: new Date(i.createdAt || Date.now()).toString() === "Invalid Date" ? new Date().toISOString() : new Date(i.createdAt).toISOString()
    });
  }
  return out;
}

export async function watchlist(req, res) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "wl", s.id, 30)) return;
  try {
    if (req.method === "GET") {
      const r = await db().query(`SELECT items, invested_usd::float8 AS invested_usd FROM user_watchlists WHERE user_id=$1`, [s.id]);
      const lim = await limitsFor(s.id);
      const items = r.rows[0]?.items || [];
      return send(res, 200, { ok: true, items, investedUsd: r.rows[0]?.invested_usd ?? null,
        limit: lim.watchlist, walletLimit: lim.wallets, contractLimit: lim.contracts,
        walletCount: items.filter(x => x.type === "wallet").length,
        contractCount: items.filter(x => x.type === "contract").length, plan: lim.plan });
    }
    if (req.method === "PUT") {
      const items = clean(req.body?.items);
      const lim = await limitsFor(s.id);
      const walletCount = items.filter(x => x.type === "wallet").length;
      const contractCount = items.filter(x => x.type === "contract").length;
      if (walletCount > lim.wallets) return send(res, 403, { ok: false, error: "WALLET_LIMIT_REACHED", limit: lim.wallets, plan: lim.plan });
      if (contractCount > lim.contracts) return send(res, 403, { ok: false, error: "CONTRACT_LIMIT_REACHED", limit: lim.contracts, plan: lim.plan });
      let inv = req.body?.investedUsd;
      inv = inv === null || inv === undefined || inv === "" ? null : Number(inv);
      if (inv !== null && (!Number.isFinite(inv) || inv < 0 || inv > 1e12)) return send(res, 400, { ok: false, error: "INVALID_INVESTED" });
      await db().query(
        `INSERT INTO user_watchlists (user_id, items, invested_usd) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET items=EXCLUDED.items, invested_usd=EXCLUDED.invested_usd, updated_at=NOW()`,
        [s.id, JSON.stringify(items), inv]);
      return send(res, 200, { ok: true, items, investedUsd: inv });
    }
    return methodNotAllowed(res, ["GET", "PUT"]);
  } catch { return send(res, 500, { ok: false, error: "WATCHLIST_FAILED" }); }
}
