// Evidence-based Smart Money analytics built only from wallets the user follows and
// transaction history already indexed by the PnL engine. No wallet profitability is inferred
// when there is insufficient closed-trade history.
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { computePnl } from "./pnl_engine.js";

const DAY = 86400000;
let schemaPromise;
const ensureCacheSchema = () => schemaPromise || (schemaPromise = db().query(`CREATE TABLE IF NOT EXISTS pnl_cache (
  user_id BIGINT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL,
  trades JSONB NOT NULL DEFAULT '[]', last_ts BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, network, address)
)`).catch(err => { schemaPromise = null; throw err; }));
const round = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

import { walletScore } from "./smart_money_score.js";

export async function smartMoney(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "smart-money", session.id, 12)) return;
  try {
    await ensureCacheSchema();
    const watch = await db().query(`SELECT items FROM user_watchlists WHERE user_id=$1`, [session.id]);
    const followed = (Array.isArray(watch.rows[0]?.items) ? watch.rows[0].items : [])
      .filter(x => x?.type === "wallet" && x.category === "Smart Money");
    if (!followed.length) return send(res, 200, { ok: true, wallets: [], signals: [], summary: { followed: 0, withHistory: 0 }, limitations: ["Follow wallets with the Smart Money category to build your dashboard."] });
    const cache = await db().query(`SELECT network,address,trades,updated_at FROM pnl_cache WHERE user_id=$1`, [session.id]);
    const byKey = new Map(cache.rows.map(r => [`${r.network}:${String(r.address).toLowerCase()}`, r]));
    const wallets = [], recent = [];
    for (const item of followed.slice(0, 30)) {
      const row = byKey.get(`${item.network}:${String(item.address).toLowerCase()}`);
      const trades = Array.isArray(row?.trades) ? row.trades : [];
      const pnl = computePnl(trades, { sinceTs: Date.now() - 30 * DAY, marks: {} });
      const score = walletScore(pnl, trades.filter(t => t.ts >= Date.now() - 30 * DAY));
      wallets.push({ id: item.id, name: item.name, network: item.network, address: item.address,
        score: score.score, scoreConfidence: score.confidence, scoreBasis: score.basis,
        realizedUsd: round(pnl.summary.realizedUsd), unrealizedUsd: round(pnl.summary.unrealizedUsd),
        winRate: pnl.summary.winRate, closedTrades: pnl.summary.closedTrades, trades30d: pnl.summary.trades,
        historyUpdatedAt: row?.updated_at || null, hasHistory: trades.length > 0, indexed: !!row, tradesTotal: trades.length,
        status: !row ? "not_indexed" : trades.length === 0 ? "no_swaps" : pnl.summary.closedTrades < 3 ? "few_closed_trades" : "scored" });
      for (const t of trades) if (t.ts >= Date.now() - DAY) recent.push({ ...t, walletName: item.name, walletNetwork: item.network });
    }
    // Token symbols are grouped only within a network. Same ticker on different chains is not assumed to be the same asset.
    const groups = new Map();
    for (const t of recent) {
      const key = `${t.network}:${String(t.token?.key || t.token?.symbol || "unknown")}:${t.side}`;
      const g = groups.get(key) || { network: t.network, token: t.token?.symbol || "Unknown", side: t.side, wallets: new Set(), volumeUsd: 0, latestAt: 0 };
      if (g.side === t.side) { g.wallets.add(t.wallet); g.volumeUsd += Number(t.usdValue) || 0; g.latestAt = Math.max(g.latestAt, t.ts); }
      groups.set(key, g);
    }
    const signals = [...groups.values()].filter(g => g.wallets.size >= 2).map(g => ({ type: g.side === "buy" ? "MULTI_WALLET_ACCUMULATION" : "MULTI_WALLET_DISTRIBUTION", network: g.network, token: g.token, wallets: g.wallets.size, observedVolumeUsd: round(g.volumeUsd), latestAt: g.latestAt, confidence: "observed", note: `At least ${g.wallets.size} followed wallets recorded ${g.side} swaps in the last 24 hours` })).sort((a,b) => b.latestAt-a.latestAt).slice(0,20);
    wallets.sort((a,b) => (b.score ?? -1) - (a.score ?? -1));
    return send(res, 200, { ok: true, wallets, signals, summary: { followed: wallets.length, indexed: wallets.filter(w => w.indexed).length, withHistory: wallets.filter(w => w.hasHistory).length, signals24h: signals.length }, limitations: ["Discovery is limited to wallets you follow; no external profitable-wallet discovery provider is configured.", "Signals use indexed swap history only. They do not prove intent, identify a trader, or predict price movement.", "Cross-chain wallet identity correlation is not available; identical token symbols across networks are kept separate.", "PnL may be incomplete when indexer history, historical prices, or token valuations are unavailable."], updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[smart-money]", e.message);
    return send(res, 500, { ok: false, error: "SMART_MONEY_FAILED" });
  }
}
