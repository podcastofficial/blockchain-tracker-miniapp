// Combined portfolio view across ALL saved wallets + tax-style report.
//   GET /api/portfolio/combined?days=30      combined realized / unrealized PnL, per-wallet table, cumulative PnL chart series, value history
//   GET /api/portfolio/report?year=2026      realized-gains summary for the year (rows only for paid / trial users)
// Built from the swap history already indexed in pnl_cache (run Analyze in Portfolio / Smart Money to index or refresh wallets).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { SUPPORTED, validAddr } from "./balances.js";
import { limitsFor } from "./plans.js";
import { analyticsAccess, premiumAccess, FREE_HISTORY_DAYS } from "./entitle.js";
import { computePnl } from "./pnl_engine.js";
import { livePrices } from "./live_price.js";
import { disposals, taxReport } from "./tax_report.js";
import { trackUsage } from "./usage.js";

const DAY = 86400000, r2 = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

export async function userWallets(uid, { category = "", only = "" } = {}) {
  const lim = await limitsFor(uid).catch(() => ({ wallets: 10 }));
  const wl = await db().query(`SELECT items FROM user_watchlists WHERE user_id=$1`, [uid]);
  let items = (Array.isArray(wl.rows[0]?.items) ? wl.rows[0].items : []).filter(i => i?.type === "wallet" && SUPPORTED.includes(i.network) && validAddr(i.network, i.address));
  if (category) items = items.filter(i => String(i.category || "") === category);
  if (only) { const [n, ...rest] = only.split(":"), a = rest.join(":"); items = items.filter(i => i.network === n && i.address.toLowerCase() === a.toLowerCase()); }
  return items.slice(0, lim.wallets);
}

// Cached trades only (no network calls). Returns [{ item, trades, updatedAt }]
export async function cachedTrades(uid, items) {
  if (!items.length) return [];
  let rows = [];
  try { rows = (await db().query(`SELECT network, address, trades, updated_at FROM pnl_cache WHERE user_id=$1`, [uid])).rows; }
  catch { rows = []; }                      // pnl_cache is created on first PnL analyze
  const by = new Map(rows.map(r => [`${r.network}:${String(r.address).toLowerCase()}`, r]));
  return items.map(item => { const r = by.get(`${item.network}:${item.address.toLowerCase()}`); return { item, trades: Array.isArray(r?.trades) ? r.trades : [], updatedAt: r?.updated_at || null, indexed: !!r }; });
}

export async function portfolioCombined(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "pf-combined", s.id, 12)) return;
  try {
    const full = await analyticsAccess(s.id);
    let days = [7, 30, 90].includes(Number(new URL(req.url, "https://x.invalid").searchParams.get("days"))) ? Number(new URL(req.url, "https://x.invalid").searchParams.get("days")) : 30;
    if (!full && days > FREE_HISTORY_DAYS) days = FREE_HISTORY_DAYS;
    const items = await userWallets(s.id);
    if (!items.length) return send(res, 400, { ok: false, error: "NO_WALLETS" });
    const data = await cachedTrades(s.id, items), now = Date.now(), since = now - days * DAY;
    // one batched live-price lookup for every open token across every wallet
    const first = data.map(d => computePnl(d.trades, { sinceTs: since, marks: {} }));
    const keys = [...new Set(first.flatMap(p => p.byToken.filter(t => t.holding > 1e-12 && !t.key.endsWith(":native")).map(t => t.key)))].slice(0, 90);
    const marks = keys.length ? await livePrices(keys, { timeoutMs: 4500 }).catch(() => ({})) : {};
    const per = data.map((d, i) => (Object.keys(marks).length ? computePnl(d.trades, { sinceTs: since, marks }) : first[i]));
    const wallets = data.map((d, i) => ({ name: d.item.name, network: d.item.network, address: d.item.address, category: d.item.category || null, indexed: d.indexed, updatedAt: d.updatedAt, swaps: d.trades.length,
      realizedUsd: r2(per[i].summary.realizedUsd), unrealizedUsd: r2(per[i].summary.unrealizedUsd), winRate: per[i].summary.winRate, closedTrades: per[i].summary.closedTrades }));
    const all = data.flatMap(d => d.trades.map(t => ({ ...t, wallet: t.wallet || d.item.address })));
    const comb = computePnl(all, { sinceTs: since, marks });
    // cumulative realized PnL per day (chart)
    const daily = new Map();
    for (const d of disposals(all)) if (d.soldAt >= since && d.gainUsd != null) { const k = new Date(d.soldAt).toISOString().slice(0, 10); daily.set(k, (daily.get(k) || 0) + d.gainUsd); }
    const series = []; let cum = 0;
    for (let t = Math.floor(since / DAY) * DAY; t <= now; t += DAY) { const k = new Date(t).toISOString().slice(0, 10); cum += daily.get(k) || 0; series.push({ date: k, dayUsd: r2(daily.get(k) || 0), cumulativeUsd: r2(cum) }); }
    let valueHistory = [];
    try { valueHistory = (await db().query(`SELECT taken_at, total_usd::float8 AS v FROM portfolio_snapshots WHERE user_id=$1 AND taken_at > NOW() - make_interval(days => $2) ORDER BY taken_at ASC LIMIT 500`, [s.id, days])).rows.map(x => ({ t: x.taken_at, v: x.v })); } catch { /* table optional */ }
    trackUsage(s.id, "portfolio_combined");
    return send(res, 200, { ok: true, locked: !full, days, wallets, notIndexed: wallets.filter(w => !w.indexed).length,
      totals: { realizedUsd: r2(comb.summary.realizedUsd), unrealizedUsd: r2(comb.summary.unrealizedUsd), totalUsd: r2(comb.summary.totalUsd), winRate: comb.summary.winRate, closedTrades: comb.summary.closedTrades, swaps: comb.summary.trades },
      topTokens: comb.byToken.slice(0, 10).map(t => ({ token: t.token, realizedUsd: r2(t.realizedUsd), unrealizedUsd: r2(t.unrealizedUsd), holding: t.holding, markSource: t.markSource })),
      series, valueHistory,
      warnings: [...(wallets.some(w => !w.indexed) ? ["Some wallets are not indexed yet. Open Trading PnL and tap refresh to index them."] : []),
        ...(comb.byToken.some(t => t.markSource === "last_trade") ? ["Open tokens without a liquid live market are valued at their last trade price."] : [])] });
  } catch (e) { console.error("[portfolio-combined]", e.message); return send(res, 500, { ok: false, error: "PORTFOLIO_FAILED" }); }
}

export async function portfolioReport(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "pf-report", s.id, 10)) return;
  try {
    const y = Number(new URL(req.url, "https://x.invalid").searchParams.get("year")) || new Date().getUTCFullYear();
    const year = Math.min(Math.max(y, 2015), new Date().getUTCFullYear());
    const items = await userWallets(s.id);
    if (!items.length) return send(res, 400, { ok: false, error: "NO_WALLETS" });
    const data = await cachedTrades(s.id, items);
    const rep = taxReport(data.flatMap(d => d.trades.map(t => ({ ...t, wallet: t.wallet || d.item.address }))), year);
    const premium = await premiumAccess(s.id);
    trackUsage(s.id, "tax_report_view");
    return send(res, 200, { ok: true, year, locked: !premium, summary: rep.summary, rows: premium ? rep.rows.slice(0, 200).map(r => ({ ...r, gainUsd: r2(r.gainUsd), proceedsUsd: r2(r.proceedsUsd), costUsd: r2(r.costUsd) })) : [], totalRows: rep.rows.length,
      notIndexed: data.filter(d => !d.indexed).length,
      disclaimer: "Bookkeeping aid built from on-chain swap history (FIFO). Transfers, airdrops, staking, LP and exchange activity are not included. Not tax advice." });
  } catch (e) { console.error("[portfolio-report]", e.message); return send(res, 500, { ok: false, error: "REPORT_FAILED" }); }
}
