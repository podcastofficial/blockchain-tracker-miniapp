// Shared entitlement checks: paid plans have everything; free users get it through MBC Points boosts.
import { planOf } from "./plans.js";
import { hasAdvancedAnalytics } from "./points.js";

export const FREE_SCANS_PER_DAY = Math.min(Math.max(parseInt(process.env.FREE_SCANS_PER_DAY || "25", 10) || 25, 1), 1000);
export const FREE_WHALE_PREVIEW = 5;      // whale events a free user sees
export const FREE_HISTORY_DAYS = 7;       // portfolio history window a free user sees (advanced: 30 days)

// Advanced Analytics = portfolio history (30 days) + P&L window, and the full Whale Feed.
export async function analyticsAccess(uid) {
  try {
    if ((await planOf(uid)) !== "free") return true;
    return await hasAdvancedAnalytics(uid);
  } catch { return false; }
}
