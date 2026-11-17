// Conservative token risk assessment. Missing provider fields remain unknown; no heuristic guesses.
const truth = v => v === true || v === 1 || v === "1" || v === "true";
const pct = v => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const first = (o, keys) => { for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null && o[k] !== "") return o[k]; return null; };

export function assessRisk(sec = null, market = null) {
  const s = sec && typeof sec === "object" ? sec : {};
  const pairs = Array.isArray(market?.pairs) ? market.pairs : [];
  const liquidity = pairs.map(p => Number(p?.liquidity?.usd)).filter(Number.isFinite);
  const lockValues = pairs.flatMap(p => [p?.liquidity?.locked, p?.liquidity?.lockPercentage, p?.liquidity?.lockedPercentage]).map(pct).filter(v => v !== null);
  const taxBuy = pct(first(s, ["buy_tax", "buy_tax_rate"]));
  const taxSell = pct(first(s, ["sell_tax", "sell_tax_rate"]));
  const ownerRenounced = first(s, ["owner_address", "owner"]) === "0x0000000000000000000000000000000000000000" || truth(s.owner_renounced);
  const ownerCanChangeTax = first(s, ["owner_change_balance", "owner_change_tax", "owner_change_tax_enabled"]);
  const mintable = first(s, ["is_mintable", "mintable"]);
  const proxy = first(s, ["is_proxy", "proxy"]);
  const honeypot = first(s, ["is_honeypot", "honeypot"]);
  const rugSignals = [];
  if (truth(honeypot)) rugSignals.push("honeypot_flagged");
  if (taxSell !== null && taxSell >= 50) rugSignals.push("extreme_sell_tax");
  if (truth(first(s, ["hidden_owner", "hidden_owner_enabled"]))) rugSignals.push("hidden_owner");
  if (truth(first(s, ["selfdestruct", "selfdestruct_enabled"]))) rugSignals.push("selfdestruct");
  if (truth(first(s, ["is_blacklisted", "blacklist"]))) rugSignals.push("blacklist_flagged");
  const ownerPermissions = {
    ownerAddress: first(s, ["owner_address", "owner"]),
    renounced: ownerRenounced ? true : (first(s, ["owner_address", "owner", "owner_renounced"]) === null ? null : false),
    canChangeTax: ownerCanChangeTax === null ? null : truth(ownerCanChangeTax),
    canBlacklist: first(s, ["is_blacklisted", "blacklist"] ) === null ? null : truth(first(s, ["is_blacklisted", "blacklist"])),
    canPause: first(s, ["transfer_pausable", "is_paused"]) === null ? null : truth(first(s, ["transfer_pausable", "is_paused"]))
  };
  return {
    provider: sec ? "goplus" : "unknown",
    honeypot: honeypot === null ? "unknown" : truth(honeypot),
    taxes: { buy: taxBuy, sell: taxSell },
    ownerPermissions,
    mint: mintable === null ? "unknown" : truth(mintable),
    proxy: proxy === null ? "unknown" : truth(proxy),
    liquidity: { usd: liquidity.length ? Math.max(...liquidity) : null, lockPercent: lockValues.length ? Math.max(...lockValues) : null, lockStatus: lockValues.length ? "reported" : "unknown" },
    rugPullSignals: rugSignals,
    riskLevel: rugSignals.length ? "high" : "unknown",
    dataCompleteness: { security: !!sec, marketPairs: pairs.length > 0, fieldsMissing: [honeypot, taxBuy, taxSell, mintable, proxy].filter(v => v === null).length }
  };
}
