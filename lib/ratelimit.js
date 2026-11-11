// Simple per-instance sliding-window limiter (good enough to blunt abuse on serverless).
import { send } from "./http.js";
const buckets = new Map();
export function clientKey(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}
export function rateLimited(req, res, name, key, max, windowMs = 60000) {
  const now = Date.now(), k = name + ":" + key;
  const arr = (buckets.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); buckets.set(k, arr);
  if (buckets.size > 5000) for (const [kk, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(kk);
  if (arr.length > max) { res.setHeader("Retry-After", Math.ceil(windowMs / 1000)); send(res, 429, { ok: false, error: "RATE_LIMITED" }); return true; }
  return false;
}
