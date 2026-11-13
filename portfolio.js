import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { SUPPORTED, validAddr, fetchBalance, fetchPrices } from "./balances.js";
import { limitsFor } from "./plans.js";
import { analyticsAccess, FREE_HISTORY_DAYS } from "./entitle.js";

const hits = new Map(); // userId -> timestamps (simple per-instance rate limit)
function limited(uid) {
  const now = Date.now(); const a = (hits.get(uid) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(uid, a); return a.length > 15;
}

export async function portfolioBalances(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  if (limited(s.id)) return send(res, 429, { ok: false, error: "RATE_LIMITED" });

  const lim = await limitsFor(s.id).catch(() => ({ wallets: 3 }));
  const list = Array.isArray(req.body?.wallets) ? req.body.wallets.slice(0, lim.wallets) : [];
  const wallets = list.map(w => ({ network: String(w?.network || "").toLowerCase(), address: String(w?.address || "").trim() }))
    .filter(w => SUPPORTED.includes(w.network) && validAddr(w.network, w.address));
  if (!wallets.length) return send(res, 400, { ok: false, error: "NO_VALID_WALLETS" });

  const prices = await fetchPrices();
  const usd = (sym, amt) => sym === "USDT" || sym === "USDC" ? amt : amt * (prices[sym]?.usd || 0);
  const alloc = {}; let total = 0, chg = 0;

  const out = await Promise.all(wallets.map(async w => {
    try {
      const b = await fetchBalance(w.network, w.address);
      const nUsd = usd(b.symbol, b.native);
      const tokens = b.tokens.filter(t => t.amount > 0).map(t => ({ symbol: t.symbol, amount: t.amount, usd: usd(t.symbol, t.amount) }));
      const wTotal = nUsd + tokens.reduce((a, t) => a + t.usd, 0);
      const ch = prices[b.symbol]?.change || 0;
      return { ...w, native: { symbol: b.symbol, amount: b.native, usd: nUsd }, tokens, totalUsd: wTotal, _ch: nUsd - nUsd / (1 + ch / 100) };
    } catch { return { ...w, error: "BALANCE_UNAVAILABLE", totalUsd: 0, tokens: [] }; }
  }));

  for (const w of out) {
    if (w.error) continue;
    total += w.totalUsd; chg += w._ch; delete w._ch;
    alloc[w.native.symbol] = (alloc[w.native.symbol] || 0) + w.native.usd;
    for (const t of w.tokens) alloc[t.symbol] = (alloc[t.symbol] || 0) + t.usd;
  }
  const allocation = Object.entries(alloc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([symbol, v]) => ({ symbol, usd: v, pct: total ? (v / total) * 100 : 0 }));

  // Save an hourly-ish snapshot for the history chart.
  try {
    if (total > 0) await db().query(
      `INSERT INTO portfolio_snapshots (user_id, total_usd, breakdown)
       SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM portfolio_snapshots WHERE user_id=$1 AND taken_at > NOW() - INTERVAL '30 minutes')`,
      [s.id, total, JSON.stringify(allocation)]);
  } catch { /* history is best-effort */ }

  return send(res, 200, { ok: true, wallets: out, totalUsd: total, change24hUsd: chg,
    change24hPct: total - chg > 0 ? (chg / (total - chg)) * 100 : 0, allocation, updatedAt: new Date().toISOString() });
}

export async function portfolioHistory(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "UNAUTHENTICATED" });
  try {
    const full = await analyticsAccess(s.id);                 // Advanced Analytics (paid plan or MBC Points boost): 30 days, else 7 days
    const days = full ? 30 : FREE_HISTORY_DAYS;
    const r = await db().query(
      `SELECT taken_at, total_usd FROM portfolio_snapshots WHERE user_id=$1 AND taken_at > NOW() - make_interval(days => $2)
       ORDER BY taken_at ASC LIMIT 500`, [s.id, days]);
    return send(res, 200, { ok: true, locked: !full, days, points: r.rows.map(x => ({ t: x.taken_at, v: Number(x.total_usd) })) });
  } catch { return send(res, 500, { ok: false, error: "HISTORY_FAILED" }); }
}
