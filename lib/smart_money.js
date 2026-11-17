// Evidence-based Smart Money analytics built only from wallets the user follows and
// transaction history already indexed by the PnL engine. No wallet profitability is inferred
// when there is insufficient closed-trade history.
//   GET  /api/smart-money            dashboard (ranking + multi-wallet signals)
//   GET  /api/smart-money/wallet     detail for one followed wallet (top tokens + recent trades)
//   GET/POST /api/smart-money/settings   auto-refresh + Telegram signal alert toggles
//   GET  /api/cron/smart-money       background worker (see lib/smart_money_worker.js)
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { computePnl } from "./pnl_engine.js";
import { SUPPORTED, validAddr } from "./balances.js";
import { walletScore } from "./smart_money_score.js";

const DAY = 86400000;
let schemaPromise;
export const ensureSmartMoneySchema = () => schemaPromise || (schemaPromise = db().query(`
CREATE TABLE IF NOT EXISTS pnl_cache (
  user_id BIGINT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL,
  trades JSONB NOT NULL DEFAULT '[]', last_ts BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, network, address)
);
CREATE TABLE IF NOT EXISTS smart_money_settings (
  user_id BIGINT PRIMARY KEY,
  auto_refresh BOOLEAN NOT NULL DEFAULT FALSE,
  alerts BOOLEAN NOT NULL DEFAULT FALSE,
  notified JSONB NOT NULL DEFAULT '{}',
  last_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`).catch(err => { schemaPromise = null; throw err; }));
const round = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

// The user's followed Smart Money wallets that the PnL indexers can handle.
export async function followedWallets(uid) {
  const watch = await db().query(`SELECT items FROM user_watchlists WHERE user_id=$1`, [uid]);
  return (Array.isArray(watch.rows[0]?.items) ? watch.rows[0].items : [])
    .filter(x => x?.type === "wallet" && x.category === "Smart Money" && SUPPORTED.includes(x.network) && validAddr(x.network, x.address));
}

// Core analysis shared by the dashboard and the alert worker.
export async function buildSmartMoney(uid) {
  await ensureSmartMoneySchema();
  const followed = await followedWallets(uid);
  if (!followed.length) return { wallets: [], signals: [], summary: { followed: 0, indexed: 0, withHistory: 0, signals24h: 0 } };
  const cache = await db().query(`SELECT network,address,trades,updated_at FROM pnl_cache WHERE user_id=$1`, [uid]);
  const byKey = new Map(cache.rows.map(r => [`${r.network}:${String(r.address).toLowerCase()}`, r]));
  const wallets = [], recent = [], now = Date.now();
  for (const item of followed.slice(0, 30)) {
    const row = byKey.get(`${item.network}:${String(item.address).toLowerCase()}`);
    const trades = Array.isArray(row?.trades) ? row.trades : [];
    const pnl = computePnl(trades, { sinceTs: now - 30 * DAY, marks: {} });
    const score = walletScore(pnl, trades.filter(t => t.ts >= now - 30 * DAY));
    wallets.push({ id: item.id, name: item.name, network: item.network, address: item.address,
      score: score.score, scoreConfidence: score.confidence, scoreBasis: score.basis,
      realizedUsd: round(pnl.summary.realizedUsd), unrealizedUsd: round(pnl.summary.unrealizedUsd),
      winRate: pnl.summary.winRate, closedTrades: pnl.summary.closedTrades, trades30d: pnl.summary.trades,
      historyUpdatedAt: row?.updated_at || null, hasHistory: trades.length > 0, indexed: !!row, tradesTotal: trades.length,
      status: !row ? "not_indexed" : trades.length === 0 ? "no_swaps" : pnl.summary.closedTrades < 3 ? "few_closed_trades" : "scored" });
    for (const t of trades) if (t.ts >= now - DAY) recent.push({ ...t, walletName: item.name, walletNetwork: item.network });
  }
  // Token symbols are grouped only within a network. Same ticker on different chains is not assumed to be the same asset.
  const groups = new Map();
  for (const t of recent) {
    const tokenKey = String(t.token?.key || t.token?.symbol || "unknown");
    const key = `${t.network}:${tokenKey}:${t.side}`;
    const g = groups.get(key) || { key, network: t.network, token: t.token?.symbol || "Unknown", side: t.side, wallets: new Set(), names: new Set(), volumeUsd: 0, latestAt: 0 };
    g.wallets.add(t.wallet); g.names.add(t.walletName); g.volumeUsd += Number(t.usdValue) || 0; g.latestAt = Math.max(g.latestAt, t.ts);
    groups.set(key, g);
  }
  const signals = [...groups.values()].filter(g => g.wallets.size >= 2).map(g => ({
    key: g.key, type: g.side === "buy" ? "MULTI_WALLET_ACCUMULATION" : "MULTI_WALLET_DISTRIBUTION", network: g.network, token: g.token,
    wallets: g.wallets.size, walletNames: [...g.names].slice(0, 6), observedVolumeUsd: round(g.volumeUsd), latestAt: g.latestAt, confidence: "observed",
    note: `At least ${g.wallets.size} followed wallets recorded ${g.side} swaps in the last 24 hours` })).sort((a, b) => b.latestAt - a.latestAt).slice(0, 20);
  wallets.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { wallets, signals, summary: { followed: wallets.length, indexed: wallets.filter(w => w.indexed).length, withHistory: wallets.filter(w => w.hasHistory).length, signals24h: signals.length } };
}

const LIMITATIONS = ["Discovery is limited to wallets you follow; no external profitable-wallet discovery provider is configured.",
  "Signals use indexed swap history only. They do not prove intent, identify a trader, or predict price movement.",
  "Cross-chain wallet identity correlation is not available; identical token symbols across networks are kept separate.",
  "PnL may be incomplete when indexer history, historical prices, or token valuations are unavailable."];

export async function smartMoney(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "smart-money", session.id, 12)) return;
  try {
    const out = await buildSmartMoney(session.id);
    if (!out.wallets.length) return send(res, 200, { ok: true, ...out, limitations: ["Follow wallets with the Smart Money category to build your dashboard."] });
    return send(res, 200, { ok: true, ...out, limitations: LIMITATIONS, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[smart-money]", e.message);
    return send(res, 500, { ok: false, error: "SMART_MONEY_FAILED" });
  }
}

// GET /api/smart-money/wallet?network=ethereum&address=0x...
export async function smartMoneyWallet(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "smart-money-wallet", session.id, 30)) return;
  try {
    await ensureSmartMoneySchema();
    const p = new URL(req.url, "https://x.invalid").searchParams;
    const network = String(p.get("network") || ""), address = String(p.get("address") || "");
    const item = (await followedWallets(session.id)).find(w => w.network === network && String(w.address).toLowerCase() === address.toLowerCase());
    if (!item) return send(res, 404, { ok: false, error: "WALLET_NOT_FOLLOWED" });
    const r = await db().query(`SELECT trades, updated_at FROM pnl_cache WHERE user_id=$1 AND network=$2 AND address=$3`, [session.id, item.network, item.address]);
    const row = r.rows[0], trades = Array.isArray(row?.trades) ? row.trades : [];
    const pnl = computePnl(trades, { sinceTs: Date.now() - 30 * DAY, marks: {} });
    const score = walletScore(pnl, trades.filter(t => t.ts >= Date.now() - 30 * DAY));
    const last24 = trades.filter(t => t.ts >= Date.now() - DAY);
    return send(res, 200, { ok: true, wallet: { name: item.name, network: item.network, address: item.address, notes: item.notes || "" },
      indexed: !!row, historyUpdatedAt: row?.updated_at || null, score: score.score, scoreConfidence: score.confidence, scoreBasis: score.basis,
      summary: { ...pnl.summary, realizedUsd: round(pnl.summary.realizedUsd), unrealizedUsd: round(pnl.summary.unrealizedUsd), totalUsd: round(pnl.summary.totalUsd), swaps24h: last24.length,
        volume30dUsd: round(trades.filter(t => t.ts >= Date.now() - 30 * DAY).reduce((a, t) => a + (Number(t.usdValue) || 0), 0)) },
      topTokens: pnl.byToken.slice(0, 8).map(t => ({ token: t.token, realizedUsd: round(t.realizedUsd), unrealizedUsd: round(t.unrealizedUsd), holding: t.holding, unknownCost: t.unknownCost })),
      recentTrades: pnl.trades.slice(0, 15).map(t => ({ ...t, usdValue: round(t.usdValue), pnlUsd: t.pnlUsd == null ? null : round(t.pnlUsd) })),
      limitations: ["Built from indexed swap history only; unrealized PnL uses the last trade price, not a live price.", "Tokens sold without a visible buy have unknown cost and are excluded from realized PnL."] });
  } catch (e) {
    console.error("[smart-money-wallet]", e.message);
    return send(res, 500, { ok: false, error: "SMART_MONEY_FAILED" });
  }
}

// GET/POST /api/smart-money/settings  { autoRefresh?: boolean, alerts?: boolean }
export async function smartMoneySettings(req, res) {
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "smart-money-settings", session.id, 20)) return;
  try {
    await ensureSmartMoneySchema();
    if (req.method === "POST") {
      let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } } b = b || {};
      const cur = (await db().query(`SELECT auto_refresh, alerts FROM smart_money_settings WHERE user_id=$1`, [session.id])).rows[0] || { auto_refresh: false, alerts: false };
      const auto = typeof b.autoRefresh === "boolean" ? b.autoRefresh : cur.auto_refresh, alerts = typeof b.alerts === "boolean" ? b.alerts : cur.alerts;
      await db().query(`INSERT INTO smart_money_settings(user_id,auto_refresh,alerts) VALUES($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET auto_refresh=EXCLUDED.auto_refresh, alerts=EXCLUDED.alerts, updated_at=NOW()`, [session.id, auto, alerts]);
      return send(res, 200, { ok: true, autoRefresh: auto, alerts });
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "POST"]);
    const r = (await db().query(`SELECT auto_refresh, alerts, last_run_at FROM smart_money_settings WHERE user_id=$1`, [session.id])).rows[0];
    return send(res, 200, { ok: true, autoRefresh: !!r?.auto_refresh, alerts: !!r?.alerts, lastRunAt: r?.last_run_at || null });
  } catch (e) {
    console.error("[smart-money-settings]", e.message);
    return send(res, 500, { ok: false, error: "SMART_MONEY_FAILED" });
  }
}
