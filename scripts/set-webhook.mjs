// Usage:
//   npm run webhook         -> sets the Telegram webhook to <APP_URL>/api/telegram/webhook
//   npm run webhook:info    -> shows current webhook status
// Needs env: TELEGRAM_BOT_TOKEN, APP_URL (or MINIAPP_URL), TELEGRAM_WEBHOOK_SECRET (recommended)
const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = (process.env.APP_URL || process.env.MINIAPP_URL || "").replace(/\/+$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const info = process.argv.includes("--info");

if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

async function call(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return r.json();
}

if (info) {
  console.log(JSON.stringify(await call("getWebhookInfo"), null, 2));
} else {
  if (!appUrl) { console.error("Missing APP_URL (e.g. https://your-app.vercel.app)"); process.exit(1); }
  const body = {
    url: `${appUrl}/api/telegram/webhook`,
    allowed_updates: ["message", "callback_query", "my_chat_member", "channel_post"],
    drop_pending_updates: true
  };
  if (secret) body.secret_token = secret;
  const out = await call("setWebhook", body);
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(1);
}
