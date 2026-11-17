// Smart Money auto-discovery: find candidate wallets from a token's top holders or its earliest buyers, then score each one
// from its real swap history (same FIFO PnL engine as the rest of the app). Nothing is followed automatically.
//   GET /api/smart-money/discover?network=&address=&mode=holders|early     -> candidate list (cheap, no PnL yet)
//   GET /api/smart-money/discover/analyze?network=&address=                -> PnL / win rate / score for ONE wallet
// Splitting it in two keeps every request short (serverless time limits) and lets the UI fill the table row by row.
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { EVM, SUPPORTED, validAddr, j, rpc } from "./balances.js";
import { computePnl } from "./pnl_engine.js";
import { fetchTrades, loadNativePrices, makePriceAt } from "./pnl.js";
import { NATIVE_SYM } from "./pnl_engine.js";
import { walletScore } from "./smart_money_score.js";
import { premiumAccess, FREE_DISCOVERY_PER_DAY } from "./entitle.js";
import { trackUsage, usageToday, noteProvider } from "./usage.js";

const CHAIN_ID = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
const BLOCKSCOUT = { ethereum: "https://eth.blockscout.com", optimism: "https://optimism.blockscout.com", base: "https://base.blockscout.com", arbitrum: "https://arbitrum.blockscout.com", polygon: "https://polygon.blockscout.com" };
const GOPLUS = { ...Object.fromEntries(Object.entries(CHAIN_ID).map(([k, v]) => [k, String(v)])), tron: "tron" };
const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000000000000000000000000"]);
const HOLDER_NETS = [...Object.keys(CHAIN_ID), "solana", "tron", "ton"], EARLY_NETS = Object.keys(CHAIN_ID);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const clean = k => String(k || "").trim().replace(/^["']+|["']+$/g, "").trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const norm = (net, a) => (EVM[net] ? String(a).toLowerCase() : String(a));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_CANDIDATES = 20;

async function tracked(provider, fn) {
  try { const v = await fn(); noteProvider(provider, true); return v; } catch (e) { noteProvider(provider, false, e.message); throw e; }
}

// ---------------- holders ----------------
async function evmHolders(net, token) {
  const out = [];
  if (BLOCKSCOUT[net]) {
    try {
      const [h, t] = await tracked("blockscout", () => Promise.all([
        j(`${BLOCKSCOUT[net]}/api/v2/tokens/${token}/holders`),
        j(`${BLOCKSCOUT[net]}/api/v2/tokens/${token}`).catch(() => ({}))]));
      const dec = Number(t.decimals) || 18, supply = Number(t.total_supply) / 10 ** dec;
      for (const it of h.items || []) {
        const a = String(it.address?.hash || "").toLowerCase();
        if (!a || it.address?.is_contract) continue;
        const bal = Number(it.value) / 10 ** dec;
        out.push({ address: a, balance: bal, sharePct: supply > 0 ? (bal / supply) * 100 : null, label: it.address?.name || null });
      }
      if (out.length) return out;
    } catch { /* fall back to GoPlus */ }
  }
  const g = await tracked("goplus", () => j(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS[net]}?contract_addresses=${token}`));
  const d = g?.result && Object.values(g.result)[0];
  for (const h of d?.holders || []) {
    const a = String(h.address || "").toLowerCase();
    if (!a || Number(h.is_contract) === 1) continue;
    out.push({ address: a, balance: num(h.balance), sharePct: num(h.percent) != null ? num(h.percent) * 100 : null, label: h.tag || null });
  }
  return out;
}
async function solanaHolders(mint) {
  const url = process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com";
  const largest = await tracked("solana-rpc", () => rpc(url, "getTokenLargestAccounts", [mint]));
  const accs = (largest?.value || []).slice(0, MAX_CANDIDATES);
  if (!accs.length) return [];
  const info = await rpc(url, "getMultipleAccounts", [accs.map(a => a.address), { encoding: "jsonParsed" }]);
  const owners = (info?.value || []).map(v => v?.data?.parsed?.info?.owner || null);
  const uniq = [...new Set(owners.filter(Boolean))];
  const ownerInfo = uniq.length ? await rpc(url, "getMultipleAccounts", [uniq, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]) : { value: [] };
  const plain = new Set(uniq.filter((o, i) => ownerInfo.value?.[i] && ownerInfo.value[i].owner === SYSTEM_PROGRAM));   // wallets only; pools / PDAs are owned by programs
  const supplyR = await rpc(url, "getTokenSupply", [mint]).catch(() => null), supply = Number(supplyR?.value?.uiAmount) || 0;
  const out = [], seen = new Set();
  accs.forEach((a, i) => {
    const o = owners[i]; if (!o || !plain.has(o) || seen.has(o)) return; seen.add(o);
    const bal = Number(a.uiAmount) || 0;
    out.push({ address: o, balance: bal, sharePct: supply > 0 ? (bal / supply) * 100 : null, label: null });
  });
  return out;
}
async function tronHolders(token) {
  const g = await tracked("goplus", () => j(`https://api.gopluslabs.io/api/v1/token_security/tron?contract_addresses=${token}`));
  const d = g?.result && Object.values(g.result)[0];
  return (d?.holders || []).filter(h => h.address && Number(h.is_contract) !== 1).map(h => ({ address: h.address, balance: num(h.balance), sharePct: num(h.percent) != null ? num(h.percent) * 100 : null, label: h.tag || null }));
}
async function tonHolders(jetton) {
  const r = await tracked("tonapi", () => j(`https://tonapi.io/v2/jettons/${encodeURIComponent(jetton)}/holders?limit=${MAX_CANDIDATES}`));
  return (r.addresses || []).map(h => ({ address: h.owner?.address || h.address, balance: num(h.balance), sharePct: null, label: h.owner?.name || null })).filter(h => h.address && !h.owner?.is_scam);
}

// ---------------- early buyers (EVM) ----------------
async function evmEarly(net, token) {
  const q = root => `${root}${root.includes("?") ? "&" : "?"}${new URLSearchParams({ module: "account", action: "tokentx", contractaddress: token, page: "1", offset: "100", sort: "asc" })}`;
  const key = clean(process.env.ETHERSCAN_API_KEY);
  const tries = [];
  if (BLOCKSCOUT[net]) tries.push(() => j(q(`${BLOCKSCOUT[net]}/api`)));
  if (key) tries.push(() => j(q(`https://api.etherscan.io/v2/api?chainid=${CHAIN_ID[net]}&apikey=${encodeURIComponent(key)}`)));
  if (!tries.length) throw new Error("INDEXER_NOT_CONFIGURED");
  let rows = null, lastErr;
  for (const t of tries) { try { const r = await tracked("indexer-" + net, t); if (Array.isArray(r.result)) { rows = r.result; break; } lastErr = new Error(/plan|upgrade|not supported/i.test(String(r.result || r.message)) ? "INDEXER_PLAN_LIMIT" : "INDEXER_ERROR"); } catch (e) { lastErr = e; } }
  if (!rows) throw lastErr || new Error("INDEXER_ERROR");
  const tokenL = token.toLowerCase(), first = new Map();
  for (const t of rows) {
    const to = String(t.to || "").toLowerCase(), from = String(t.from || "").toLowerCase();
    if (!to || DEAD.has(to) || to === tokenL || from === "0x0000000000000000000000000000000000000000") continue;   // mints go to the deployer/team, not buyers
    if (!first.has(to)) first.set(to, { address: to, firstAt: Number(t.timeStamp) * 1000, amount: Number(t.value) / 10 ** (Number(t.tokenDecimal) || 18), via: from });
  }
  // Drop contracts (pools, routers, vesting): a buyer is an EOA. eth_getCode, small parallel batches.
  const url = process.env["RPC_" + net.toUpperCase()] || EVM[net].rpc, list = [...first.values()].slice(0, 40), keep = [];
  for (let i = 0; i < list.length; i += 10) {
    const part = await Promise.all(list.slice(i, i + 10).map(c => rpc(url, "eth_getCode", [c.address, "latest"]).then(code => ({ c, eoa: code === "0x" || code === "0x0" })).catch(() => ({ c, eoa: null }))));
    for (const p of part) if (p.eoa) keep.push(p.c);
  }
  // Wallets that only ever received from the token's own deployer are likely team/airdrop; keep order = how early they were.
  return keep.slice(0, MAX_CANDIDATES).map((c, i) => ({ address: c.address, balance: null, sharePct: null, label: null, firstAt: c.firstAt, rank: i + 1, firstAmount: c.amount }));
}

export async function discoverCandidates(network, token, mode) {
  if (mode === "early") {
    if (!EARLY_NETS.includes(network)) throw new Error("EARLY_BUYERS_NOT_SUPPORTED");
    return evmEarly(network, norm(network, token));
  }
  if (EVM[network]) return evmHolders(network, norm(network, token));
  if (network === "solana") return solanaHolders(token);
  if (network === "tron") return tronHolders(token);
  if (network === "ton") return tonHolders(token);
  throw new Error("UNSUPPORTED_NETWORK");
}

// ---------------- scoring one wallet ----------------
export async function analyzeWallet(network, address, tokenKey) {
  const pt = await loadNativePrices([NATIVE_SYM[network]].filter(Boolean));
  const got = await fetchTrades(network, address, makePriceAt(pt), 2);
  const since = Date.now() - 90 * 86400000;
  const pnl = computePnl(got.trades, { sinceTs: since, marks: {} });
  const score = walletScore(pnl, got.trades.filter(t => t.ts >= since));
  const tk = tokenKey ? pnl.byToken.find(t => t.key === tokenKey) : null;
  const tradesOnToken = tokenKey ? got.trades.filter(t => t.token.key === tokenKey) : [];
  return {
    network, address, swaps: got.trades.length, closedTrades: pnl.summary.closedTrades, winRate: pnl.summary.winRate,
    realizedUsd: Math.round(pnl.summary.realizedUsd * 100) / 100, unrealizedUsd: Math.round(pnl.summary.unrealizedUsd * 100) / 100,
    score: score.score, scoreConfidence: score.confidence, scoreBasis: score.basis,
    status: !got.trades.length ? "no_swaps" : pnl.summary.closedTrades < 3 ? "few_closed_trades" : "scored",
    onToken: tokenKey ? { trades: tradesOnToken.length, realizedUsd: tk ? Math.round(tk.realizedUsd * 100) / 100 : null, holding: tk ? tk.holding : 0 } : null,
    windowDays: 90
  };
}

// ---------------- routes ----------------
const ERR = { INDEXER_NOT_CONFIGURED: 503, INDEXER_PLAN_LIMIT: 502, EARLY_BUYERS_NOT_SUPPORTED: 400, UNSUPPORTED_NETWORK: 400 };
export async function discoverApi(req, res, path) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  const p = new URL(req.url, "https://x.invalid").searchParams;
  const network = String(p.get("network") || "").toLowerCase(), address = String(p.get("address") || "").trim();
  if (!SUPPORTED.includes(network) || !validAddr(network, address)) return send(res, 400, { ok: false, error: "INVALID_ADDRESS" });
  try {
    const premium = await premiumAccess(s.id);
    if (path === "/api/smart-money/discover/analyze") {
      if (rateLimited(req, res, "discover-analyze", s.id, 40)) return;
      if (!premium && (await usageToday(s.id, "discover_analyze")) >= Math.max(FREE_DISCOVERY_PER_DAY, 1) * 10)
        return send(res, 402, { ok: false, error: "PLAN_REQUIRED", feature: "discovery", hint: "Free daily discovery limit reached. Start the free trial or upgrade for unlimited discovery." });
      trackUsage(s.id, "discover_analyze");
      const tokenKey = String(p.get("token") || "").trim();
      const out = await analyzeWallet(network, address, tokenKey ? `${network}:${norm(network, tokenKey)}` : null);
      return send(res, 200, { ok: true, ...out });
    }
    if (rateLimited(req, res, "discover", s.id, 8)) return;
    const mode = p.get("mode") === "early" ? "early" : "holders";
    if (!premium && FREE_DISCOVERY_PER_DAY >= 0 && (await usageToday(s.id, "discover")) >= FREE_DISCOVERY_PER_DAY)
      return send(res, 402, { ok: false, error: "PLAN_REQUIRED", feature: "discovery", limit: FREE_DISCOVERY_PER_DAY, hint: "Free discovery limit reached for today. Start the free trial or upgrade." });
    const cands = await discoverCandidates(network, address, mode);
    trackUsage(s.id, "discover");
    return send(res, 200, { ok: true, network, token: address, mode, candidates: cands.slice(0, MAX_CANDIDATES),
      tokenKey: `${network}:${norm(network, address)}`, premium, freeLimit: premium ? null : FREE_DISCOVERY_PER_DAY,
      limitations: [mode === "early" ? "Early buyers = first recipients (non-contract) in the token's first 100 transfers; mints and pool/router addresses are excluded." : "Top holders excluding contracts / pools / program-owned accounts.",
        "A holder or early buyer is only a candidate. Tap Analyze to score it from its real swap history; nothing is followed automatically."] });
  } catch (e) {
    const code = ERR[e.message] ? e.message : "DISCOVERY_SOURCE_UNAVAILABLE";
    console.error("[discover]", code, e.message);
    return send(res, ERR[code] || 502, { ok: false, error: code });
  }
}
