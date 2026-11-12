// GET /api/cron/channels  (header: Authorization: Bearer <CRON_SECRET>)
// Runs every due Telegram channel alert. Called by .github/workflows/cron.yml or cron-job.org.
import { cronChannels } from "../../lib/channels.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return cronChannels(req, res);
}
