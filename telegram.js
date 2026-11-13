import crypto from "node:crypto";

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function verifyTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN_NOT_CONFIGURED");
  if (typeof initData !== "string" || !initData || initData.length > 8192) {
    throw new Error("INVALID_INIT_DATA");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("INVALID_INIT_DATA_HASH");

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey)
    .update(dataCheckString).digest("hex");

  if (!safeEqual(calculatedHash, receivedHash)) throw new Error("TELEGRAM_SIGNATURE_INVALID");

  const authDate = Number(params.get("auth_date"));
  const maxAge = Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > maxAge) {
    throw new Error("TELEGRAM_INIT_DATA_EXPIRED");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new Error("TELEGRAM_USER_MISSING");
  const user = JSON.parse(rawUser);
  if (!user || !Number.isSafeInteger(Number(user.id))) throw new Error("TELEGRAM_USER_INVALID");
  return user;
}
