export function walletScore(pnl, trades) {
  const closed = Number(pnl.summary?.closedTrades || 0);
  if (closed < 3) return { score: null, confidence: "insufficient_history", basis: "At least 3 closed trades are required" };
  const win = Number(pnl.summary?.winRate || 0);
  const realized = Number(pnl.summary?.realizedUsd || 0);
  const volume = trades.reduce((s, t) => s + (Number(t.usdValue) || 0), 0);
  // A transparent 0–100 research score, not a prediction or investment rating.
  const winPart = Math.max(0, Math.min(40, win * 40));
  const pnlPart = Math.max(0, Math.min(35, 17.5 + 17.5 * Math.tanh(realized / Math.max(volume * 0.05, 1))));
  const activityPart = Math.min(25, Math.log2(closed + 1) * 5);
  return { score: Math.round(winPart + pnlPart + activityPart), confidence: closed >= 10 ? "medium" : "low", basis: "Win rate, realized PnL relative to observed volume, and closed-trade count" };
}
