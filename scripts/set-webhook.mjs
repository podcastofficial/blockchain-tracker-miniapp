// Usage:
//   npm run webhook         -> sets the Telegram webhook to <APP_URL>/api/telegram/webhook
//   npm run webhook:info    -> shows current webhook status
// Needs env: TELEGRAM_BOT_TOKEN, APP_URL (or MINIAPP_URL), TELEGRAM_WEBHOOK_SECRET (recommended)
const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = (process.env.APP_URL || process.env.MINIAPP_URL || "").replace(/\/+$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const COMMANDS = [
  ["track","Look up an address, token or transaction"],["watchwallet","Alert on a wallet's incoming/outgoing transactions"],
  ["watchactivity","Alert on smart-contract activity"],["watchcontract","Alert on token BUY/SELL"],["watchlist","Show active watches"],
  ["unwatch","Remove a watch"],["trackinfo","Status / details of an address"],["settings","Open settings"],["price","Live price, e.g. /price btc"],
  ["alerts","Your active alerts"],["help","All commands"]
].map(([command, description]) => ({ command, description }));
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
  // Command menu everywhere: private chats, groups, and group admins (channels have no menu; admins just post the command).
  for (const scope of [{ type: "default" }, { type: "all_private_chats" }, { type: "all_group_chats" }, { type: "all_chat_administrators" }])
    console.log("setMyCommands", scope.type, (await call("setMyCommands", { commands: COMMANDS, scope })).ok);
}
