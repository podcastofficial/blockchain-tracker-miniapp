// Minimal Telegram Bot API helpers shared by the community modules. Never logs the token.
export async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await r.json();
    return data?.ok ? data.result : null;
  } catch { return null; }
}
// Authoritative admin check (live against Telegram). Use before ANY settings/removal action.
export async function isChatAdmin(chatId, telegramUserId) {
  const m = await tg("getChatMember", { chat_id: chatId, user_id: telegramUserId });
  return m?.status === "creator" || m?.status === "administrator";
}
