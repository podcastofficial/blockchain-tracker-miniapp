// Real DeFi data from DeFiLlama public API (no key). Cached 5 min, stale-on-error.
import { j } from "./balances.js";
import { send, methodNotAllowed } from "./http.js";
let cache = { t: 0, v: null };
const n = v => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
async function build() {
  const [chains, dex] = await Promise.allSettled([
    j("https://api.llama.fi/v2/chains"),
    j("https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true")
  ]);
  const out = { tvlTotal: null, chains: [], dex: null };
  if (chains.status === "fulfilled" && Array.isArray(chains.value)) {
    const c = chains.value.filter(x => n(x.tvl) > 0).sort((a, b) => b.tvl - a.tvl);
    out.tvlTotal = c.reduce((a, x) => a + x.tvl, 0);
    out.chains = c.slice(0, 12).map(x => ({ name: String(x.name), tvl: x.tvl }));
  }
  if (dex.status === "fulfilled" && dex.value) {
    const d = dex.value;
    const top = (d.protocols || []).filter(p => n(p.total24h) > 0).sort((a, b) => b.total24h - a.total24h).slice(0, 10)
      .map(p => ({ name: String(p.displayName || p.name), volume24h: p.total24h, change1d: n(p.change_1d), chains: (p.chains || []).length }));
    out.dex = { total24h: n(d.total24h), change1d: n(d.change_1d), protocolCount: (d.protocols || []).length, top };
  }
  if (out.tvlTotal === null && !out.dex) throw new Error("UPSTREAM");
  return out;
}
export async function defiOverview(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    if (!cache.v || Date.now() - cache.t > 300000) cache = { t: Date.now(), v: await build() };
  } catch { if (!cache.v) return send(res, 502, { ok: false, error: "DEFI_SOURCE_UNAVAILABLE" }); }
  res.setHeader("Cache-Control", "public, s-maxage=120");
  return send(res, 200, { ok: true, ...cache.v, source: "DeFiLlama", updatedAt: new Date(cache.t).toISOString() });
}
