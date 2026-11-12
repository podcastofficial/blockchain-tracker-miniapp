// Multi-chain wallet overview: one 0x address -> native + USDT/USDC balance on every supported EVM chain, priced in USD.
// History for each chain is served by /api/tx/history?q=<address>&network=<chain> (or without network for all chains merged).
import { EVM, fetchBalance, fetchPrices, validAddr } from "./balances.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";

export async function multiChainOverview(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "mc", s.id, 20)) return;
  const address = String(new URL(req.url, "https://x.invalid").searchParams.get("address") || "").trim();
  if (!validAddr("ethereum", address)) return send(res, 400, { ok: false, error: "INVALID_ADDRESS" });

  const prices = await fetchPrices();
  const usd = (sym, amt) => sym === "USDT" || sym === "USDC" ? amt : amt * (prices[sym]?.usd || 0);
  const nets = Object.keys(EVM);
  const settled = await Promise.allSettled(nets.map(n => fetchBalance(n, address)));
  let totalUsd = 0;
  const chains = settled.map((r, i) => {
    const network = nets[i];
    if (r.status !== "fulfilled") return { network, error: "BALANCE_UNAVAILABLE", totalUsd: 0, native: null, tokens: [] };
    const b = r.value, nUsd = usd(b.symbol, b.native);
    const tokens = b.tokens.filter(t => t.amount > 0).map(t => ({ symbol: t.symbol, amount: t.amount, usd: usd(t.symbol, t.amount) }));
    const t = nUsd + tokens.reduce((a, x) => a + x.usd, 0);
    totalUsd += t;
    return { network, native: { symbol: b.symbol, amount: b.native, usd: nUsd }, tokens, totalUsd: t };
  }).sort((a, b) => b.totalUsd - a.totalUsd);
  return send(res, 200, { ok: true, address, chains, totalUsd, failed: chains.filter(c => c.error).map(c => c.network), updatedAt: new Date().toISOString() });
}
