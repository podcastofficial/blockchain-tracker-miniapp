// Tax-style realized gains report (pure functions, offline-testable). FIFO lots, same swap-based trades as the PnL engine.
// It reports what the on-chain swap history shows: acquisition date, disposal date, proceeds, cost basis, gain/loss, short/long term.
// It is a bookkeeping aid, NOT tax advice: transfers, airdrops, staking, LP and non-swap activity are not part of the data.
const YEAR_MS = 365 * 86400000;

// trades: normalized trades (see pnl_engine). Returns every disposal (sell matched against buy lots).
export function disposals(trades) {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || (a.side === "buy" ? -1 : 1));
  const books = new Map(), out = [];
  for (const t of sorted) {
    if (!(t.amount > 0) || !(t.usdValue > 0)) continue;
    const key = t.network + ":" + t.token.key, b = books.get(key) || { lots: [], symbol: t.token.symbol }; books.set(key, b);
    const fee = t.feeUsd || 0;
    if (t.side === "buy") { b.lots.push({ qty: t.amount, unit: (t.usdValue + fee) / t.amount, ts: t.ts }); continue; }
    let rem = t.amount;
    const unitProceeds = (t.usdValue - fee) / t.amount;
    while (rem > t.amount * 1e-9 && b.lots.length) {
      const lot = b.lots[0], take = Math.min(rem, lot.qty);
      const proceeds = take * unitProceeds, cost = take * lot.unit;
      out.push({ soldAt: t.ts, acquiredAt: lot.ts, network: t.network, token: b.symbol, qty: take, proceedsUsd: proceeds, costUsd: cost, gainUsd: proceeds - cost,
        term: t.ts - lot.ts > YEAR_MS ? "long" : "short", txHash: t.txHash, wallet: t.wallet });
      lot.qty -= take; rem -= take;
      if (lot.qty <= 1e-15 || lot.qty < take * 1e-9) b.lots.shift();
    }
    // Sold more than the visible buys: cost basis unknown. Reported separately, never assumed to be zero.
    if (rem > t.amount * 1e-6) out.push({ soldAt: t.ts, acquiredAt: null, network: t.network, token: b.symbol, qty: rem, proceedsUsd: rem * unitProceeds, costUsd: null, gainUsd: null, term: "unknown", txHash: t.txHash, wallet: t.wallet });
  }
  return out;
}

export function taxReport(trades, year) {
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const rows = disposals(trades).filter(d => d.soldAt >= from && d.soldAt < to).sort((a, b) => a.soldAt - b.soldAt);
  const sum = f => rows.reduce((a, r) => a + (f(r) || 0), 0), known = rows.filter(r => r.gainUsd != null);
  const bucket = term => { const r = known.filter(x => x.term === term); return { proceedsUsd: r.reduce((a, x) => a + x.proceedsUsd, 0), costUsd: r.reduce((a, x) => a + x.costUsd, 0), gainUsd: r.reduce((a, x) => a + x.gainUsd, 0), count: r.length }; };
  const feesUsd = trades.filter(t => t.ts >= from && t.ts < to).reduce((a, t) => a + (t.feeUsd || 0), 0);
  return {
    year, rows,
    summary: { disposals: rows.length, proceedsUsd: sum(r => (r.gainUsd != null ? r.proceedsUsd : 0)), costUsd: sum(r => r.costUsd), netGainUsd: sum(r => r.gainUsd),
      shortTerm: bucket("short"), longTerm: bucket("long"), unknownCostDisposals: rows.length - known.length, unknownCostProceedsUsd: rows.filter(r => r.gainUsd == null).reduce((a, r) => a + r.proceedsUsd, 0), networkFeesUsd: feesUsd }
  };
}
