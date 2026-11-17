import { send, methodNotAllowed } from "./http.js";
import { rateLimited, clientKey } from "./ratelimit.js";

const ALLOWED_CHAINS = new Set([1, 56, 137, 42161, 8453, 10, 43114]);
const ADDR = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT = /^\d{1,80}$/;
const feeRate = 0.005;

export function swapConfig() {
  const integrator = String(process.env.LIFI_INTEGRATOR || "").trim();
  const apiKey = String(process.env.LIFI_API_KEY || "").trim();
  const feeEnabled = process.env.LIFI_FEE_ENABLED === "1" && !!integrator && !!apiKey;
  return {
    ok: true,
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || "",
    integrator: feeEnabled ? integrator : "",
    platformFee: feeRate,
    platformFeePercent: 0.5,
    feeEnabled,
    tradingEnabled: feeEnabled,
    setupRequired: !feeEnabled,
    setupMessage: feeEnabled ? "Platform fee collection enabled." : "Trading is paused until LI.FI Partner Portal integration, API key and fee collection are configured.",
  };
}

export async function swapQuote(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (rateLimited(req, res, "swap-quote", clientKey(req), 30)) return;
  const cfg = swapConfig();
  if (!cfg.tradingEnabled) return send(res, 503, { ok: false, error: "TRADING_SETUP_REQUIRED", message: cfg.setupMessage, feePercent: 0.5 });
  const b = req.body || {};
  const fromChain = Number(b.fromChain), toChain = Number(b.toChain);
  const fromToken = String(b.fromToken || ""), toToken = String(b.toToken || "");
  const fromAmount = String(b.fromAmount || ""), fromAddress = String(b.fromAddress || "");
  const slippage = Number(b.slippage);
  if (!ALLOWED_CHAINS.has(fromChain) || !ALLOWED_CHAINS.has(toChain) || !ADDR.test(fromToken) && fromToken !== "0x0000000000000000000000000000000000000000" || !ADDR.test(toToken) && toToken !== "0x0000000000000000000000000000000000000000" || !AMOUNT.test(fromAmount) || !ADDR.test(fromAddress) || !Number.isFinite(slippage) || slippage <= 0 || slippage > 0.05) {
    return send(res, 400, { ok: false, error: "INVALID_SWAP_QUOTE_REQUEST" });
  }
  const url = new URL("https://li.quest/v1/quote");
  for (const [k, v] of Object.entries({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, slippage, integrator: cfg.integrator, fee: cfg.platformFee })) url.searchParams.set(k, String(v));
  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json", "x-lifi-api-key": process.env.LIFI_API_KEY }, signal: AbortSignal.timeout(12000) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return send(res, upstream.status === 429 ? 429 : 502, { ok: false, error: data.error || data.message || "LIFI_QUOTE_FAILED", message: data.message || "LI.FI could not quote this trade." });
    return send(res, 200, { ok: true, quote: data, platformFeePercent: 0.5, platformFeeRate: cfg.platformFee });
  } catch (e) {
    return send(res, 502, { ok: false, error: "LIFI_UPSTREAM_UNAVAILABLE", message: "LI.FI quote service is temporarily unavailable." });
  }
}
