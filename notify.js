// Small Telegram Bot API helpers shared by profile / payments / broadcast / export.
const base = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function tgCall(method, body, timeout = 9000) {
  try {
    const r = await fetch(`${base()}/${method}`, {
      method: "POST",
      ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout)
    });
    let j = {}; try { j = await r.json(); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, retryAfter: j?.parameters?.retry_after || 0 };
  } catch { return { ok: false, status: 0, retryAfter: 0 }; }
}

export async function sendText(chatId, text, extra = {}) {
  const r = await tgCall("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra });
  return r.ok;
}

export async function sendDocument(chatId, filename, content, caption = "") {
  const f = new FormData();
  f.append("chat_id", String(chatId));
  if (caption) f.append("caption", String(caption).slice(0, 900));
  f.append("document", new Blob([content], { type: "text/csv" }), filename);
  return (await tgCall("sendDocument", f, 20000)).ok;
}

export const appButton = () => /^https:\/\//.test(process.env.MINIAPP_URL || "")
  ? { reply_markup: { inline_keyboard: [[{ text: "📊 Open Blockchain Tracker", web_app: { url: process.env.MINIAPP_URL } }]] } } : {};
