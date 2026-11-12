// Background jobs that piggy-back on the existing 5-minute worker (/api/cron/alerts), so no new scheduler is needed.
import { recheckPayments, expiryReminders } from "./payments.js";
import { processBroadcasts } from "./broadcast.js";

export async function runMaintenance() {
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e?.message || "FAILED").slice(0, 60) }; } };
  await Promise.all([
    step("payments", () => recheckPayments(15000)),
    step("reminders", () => expiryReminders()),
    step("broadcast", () => processBroadcasts(12000))
  ]);
  return out;
}
