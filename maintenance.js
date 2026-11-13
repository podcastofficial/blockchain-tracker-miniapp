// Background jobs that piggy-back on the existing 5-minute worker (/api/cron/alerts), so no new scheduler is needed.
import { recheckPayments, expiryReminders } from "./payments.js";
import { processBroadcasts } from "./broadcast.js";
import { purgeOldUpdates } from "./community.js";
import { processQueue, purgeOldNotifications } from "./community_notify.js";
import { runExpiry } from "./points.js";

// Points expiry + stale-reservation release do not need 5-minute precision: run at most once per hour per warm instance
// (the SQL is idempotent, so concurrent or repeated runs are safe).
let lastPoints = 0;
async function runPointsOncePerHour() {
  if (Date.now() - lastPoints < 3600000) return { skipped: true };
  lastPoints = Date.now();
  return runExpiry();
}

export async function runMaintenance() {
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e?.message || "FAILED").slice(0, 60) }; } };
  await Promise.all([
    step("payments", () => recheckPayments(15000)),
    step("reminders", () => expiryReminders()),
    step("broadcast", () => processBroadcasts(12000)),
    step("telegramUpdates", () => purgeOldUpdates()),
    step("communityQueue", async () => ({ ...(await processQueue(10000)), ...(await purgeOldNotifications()) })),
    step("points", () => runPointsOncePerHour())
  ]);
  return out;
}
