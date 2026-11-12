// Transaction explorer: tx-hash lookup via RPC/TronGrid, wallet history via Etherscan V2 (EVM, needs ETHERSCAN_API_KEY),
// TronGrid (TRON), Solana RPC and TONCenter. All data is read live; nothing is invented.
import crypto from "node:crypto";
import { EVM, SUPPORTED, validAddr, rpc, j } from "./balances.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";

const CHAIN_ID = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
const EXPL = { ethereum: "https://etherscan.io/tx/", bsc: "https://bscscan.com/tx/", polygon: "https://polygonscan.com/tx/", arbitrum: "https://arbiscan.io/tx/",
  base: "https://basescan.org/tx/", optimism: "https://optimistic.etherscan.io/tx/", avalanche: "https://snowtrace.io/tx/", tron: "https://tronscan.org/#/transaction/",
  solana: "https://solscan.io/tx/", ton: "https://tonviewer.com/transaction/" };
const NATIVE = { ethereum: "ETH", bsc: "BNB", polygon: "POL", arbitrum: "ETH", base: "ETH", optimism: "ETH", avalanche: "AVAX", tron: "TRX", solana: "SOL", ton: "TON" };
const rpcUrl = n => process.env["RPC_" + n.toUpperCase()] || EVM[n].rpc;
const iso = s => new Date(Number(s)).toISOString();

function units(v, dec) {
  let b; try { b = BigInt(v); } catch { return "0"; }
  const neg = b < 0n; if (neg) b = -b;
  const base = 10n ** BigInt(dec), w = b / base;
  const f = (b % base).toString().padStart(dec, "0").slice(0, 6).replace(/0+$/, "");
  return (neg ? "-" : "") + w.toString() + (f ? "." + f : "");
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function hexToTron(hex) {
  try {
    const raw = Buffer.from(hex.replace(/^0x/, ""), "hex");
    const h = n => crypto.createHash("sha256").update(n).digest();
    const full = Buffer.concat([raw, h(h(raw)).subarray(0, 4)]);
    let n = BigInt("0x" + full.toString("hex")), s = "";
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const byte of full) { if (byte === 0) s = "1" + s; else break; }
    return s;
  } catch { return hex; }
}
const kindOf = (isToken, input) => isToken ? "token" : (input && input !== "0x" ? "contract" : "native");

// ---------- tx hash lookups ----------
async function evmTx(net, hash) {
  const url = rpcUrl(net);
  const tx = await rpc(url, "eth_getTransactionByHash", [hash]);
  if (!tx) return null;
  const [rc, latest] = await Promise.all([rpc(url, "eth_getTransactionReceipt", [hash]), rpc(url, "eth_blockNumber", [])]);
  let time = null;
  if (tx.blockNumber) { const b = await rpc(url, "eth_getBlockByNumber", [tx.blockNumber, false]); time = iso(parseInt(b.timestamp, 16) * 1000); }
  const bn = tx.blockNumber ? parseInt(tx.blockNumber, 16) : null;
  const fee = rc ? units(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || tx.gasPrice), 18) : null;
  return { hash, network: net, time, from: tx.from, to: tx.to, value: units(BigInt(tx.value), 18), symbol: NATIVE[net],
    status: !rc ? "pending" : rc.status === "0x1" ? "success" : "failed", kind: kindOf(false, tx.input), block: bn,
    confirmations: bn ? Math.max(0, parseInt(latest, 16) - bn + 1) : 0, fee: fee && `${fee} ${NATIVE[net]}`, link: EXPL[net] + hash };
}
async function tronTx(hash) {
  const h = { "Content-Type": "application/json", ...(process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {}) };
  const post = (p) => j("https://api.trongrid.io" + p, { method: "POST", headers: h, body: JSON.stringify({ value: hash }) });
  const [tx, info] = await Promise.all([post("/wallet/gettransactionbyid"), post("/wallet/gettransactioninfobyid")]);
  if (!tx?.txID) return null;
  const c = tx.raw_data?.contract?.[0], v = c?.parameter?.value || {};
  return { hash, network: "tron", time: tx.raw_data?.timestamp ? iso(tx.raw_data.timestamp) : null, from: v.owner_address ? hexToTron(v.owner_address) : null,
    to: v.to_address ? hexToTron(v.to_address) : v.contract_address ? hexToTron(v.contract_address) : null, value: v.amount != null ? units(v.amount, 6) : "0", symbol: "TRX",
    status: !info?.id ? "pending" : (tx.ret?.[0]?.contractRet === "SUCCESS" ? "success" : "failed"), kind: c?.type === "TransferContract" ? "native" : "contract",
    block: info?.blockNumber || null, confirmations: null, fee: info?.fee != null ? `${units(info.fee, 6)} TRX` : null, link: EXPL.tron + hash };
}
async function solTx(sig) {
  const r = await rpc(process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com", "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  if (!r) return null;
  const keys = r.transaction?.message?.accountKeys || [];
  return { hash: sig, network: "solana", time: r.blockTime ? iso(r.blockTime * 1000) : null, from: keys[0] || null, to: null, value: null, symbol: "SOL",
    status: r.meta?.err ? "failed" : "success", kind: "contract", block: r.slot, confirmations: null, fee: r.meta ? `${units(r.meta.fee, 9)} SOL` : null, link: EXPL.solana + sig };
}
async function lookupHash(net, q) {
  if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
    const nets = net && EVM[net] ? [net] : Object.keys(EVM);
    const r = await Promise.allSettled(nets.map(n => evmTx(n, q)));
    const hit = r.find(x => x.status === "fulfilled" && x.value);
    if (hit) return [hit.value];
    if (r.every(x => x.status === "rejected")) throw new Error("UPSTREAM");
    return [];
  }
  if (/^[a-fA-F0-9]{64}$/.test(q)) { const t = await tronTx(q); return t ? [t] : []; }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(q)) { const t = await solTx(q); return t ? [t] : []; }
  return null;
}

// ---------- wallet history ----------
// Turn an Etherscan error body into a specific code so the UI can say what is actually wrong.
function indexerError(r) {
  const text = String((typeof r.result === "string" && r.result) || r.message || "").slice(0, 160);
  let code = "INDEXER_ERROR";
  if (/api key/i.test(text)) code = "INDEXER_KEY_INVALID";
  else if (/rate limit/i.test(text)) code = "INDEXER_RATE_LIMITED";
  else if (/not supported|upgrade|plan/i.test(text)) code = "INDEXER_PLAN_LIMIT";
  else if (/timeout|smaller result/i.test(text)) code = "INDEXER_TIMEOUT";
  const e = new Error(code); e.detail = text; return e;
}
const INDEXER_CODES = { INDEXER_NOT_CONFIGURED: 503, INDEXER_KEY_INVALID: 503, INDEXER_PLAN_LIMIT: 502, INDEXER_RATE_LIMITED: 429, INDEXER_TIMEOUT: 502 };
// Keyless public indexers with an Etherscan-compatible API. They cover the chains Etherscan's free plan dropped (Base, Optimism, Avalanche)
// and act as a fallback / first choice for the rest. BNB Smart Chain has no keyless indexer: it needs NODEREAL_API_KEY (free) below.
const KEYLESS = {
  ethereum: "https://eth.blockscout.com/api",
  optimism: "https://optimism.blockscout.com/api",
  base: "https://base.blockscout.com/api",
  arbitrum: "https://arbitrum.blockscout.com/api",
  polygon: "https://polygon.blockscout.com/api",
  avalanche: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api"
};
const etherscanKey = () => String(process.env.ETHERSCAN_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();

// Works for Etherscan V2, Blockscout and Routescan: same module/action shape and the same result fields.
async function esHistory(net, addr, root, extra = {}) {
  const mk = action => root + (root.includes("?") ? "&" : "?") +
    new URLSearchParams({ module: "account", action, address: addr, page: "1", offset: "25", sort: "desc", ...extra }).toString();
  const [a, b] = await Promise.all([j(mk("txlist")), j(mk("tokentx"))]);
  const arr = r => Array.isArray(r.result) ? r.result : (r.message === "No transactions found" ? [] : (() => { throw indexerError(r); })());
  const items = [
    ...arr(a).map(t => ({ hash: t.hash, network: net, time: iso(t.timeStamp * 1000), from: t.from, to: t.to || t.contractAddress || null, value: units(t.value, 18), symbol: NATIVE[net],
      status: t.isError === "1" ? "failed" : "success", kind: kindOf(false, t.input), block: Number(t.blockNumber), link: EXPL[net] + t.hash })),
    ...arr(b).map(t => ({ hash: t.hash, network: net, time: iso(t.timeStamp * 1000), from: t.from, to: t.to, value: units(t.value, Number(t.tokenDecimal) || 18), symbol: t.tokenSymbol,
      status: "success", kind: "token", block: Number(t.blockNumber), link: EXPL[net] + t.hash }))
  ];
  return items.sort((x, y) => y.block - x.block).slice(0, 40);
}
function viaEtherscan(net, addr) {
  const key = etherscanKey(); // Vercel env values often carry stray spaces/newlines or quotes; stripped above
  if (!key) throw new Error("INDEXER_NOT_CONFIGURED");
  return esHistory(net, addr, `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID[net]}`, { apikey: key });
}
// keylessFirst=true is used for the "all networks" search so the 5 calls/sec Etherscan limit is not burned by 7 chains at once.
async function evmHistory(net, addr, keylessFirst = false) {
  if (net === "bsc" && nodeRealKey()) return bscHistory(addr);
  const kl = () => esHistory(net, addr, KEYLESS[net]), es = () => viaEtherscan(net, addr);
  const steps = !KEYLESS[net] ? [es] : keylessFirst ? [kl, es] : [es, kl];
  const errs = [];
  for (const step of steps) { try { return await step(); } catch (e) { errs.push(e); } }
  throw errs.find(e => e.message !== "INDEXER_NOT_CONFIGURED") || errs[0];
}
// ---------- BNB Smart Chain wallet history via NodeReal MegaNode (Etherscan free plan no longer covers BSC) ----------
// Needs NODEREAL_API_KEY (free plan). Used for the "bsc" network only; other networks keep using Etherscan.
const nodeRealKey = () => String(process.env.NODEREAL_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function nrTransfers(url, addr, addressType) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nr_getTransactionByAddress",
      params: [{ category: ["external", "20"], address: addr, addressType, order: "desc", maxCount: "0x1e", fromBlock: "0x0", toBlock: "latest" }] }) });
    if (!r.error) return (r.result && r.result.transfers) || [];
    const msg = String(r.error.message || "").slice(0, 160);
    if (attempt === 0 && /per second/i.test(msg)) { await sleep(1200); continue; } // free key: 150 CU/s, retry once
    const code = /unauthorized/i.test(msg) ? "INDEXER_KEY_INVALID" : /ran out of cu/i.test(msg) ? "INDEXER_PLAN_LIMIT" : /per second/i.test(msg) ? "INDEXER_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE";
    const e = new Error(code); e.detail = "nodereal: " + msg; throw e;
  }
  return [];
}
const nrBig = h => { try { return BigInt(h); } catch { return 0n; } };
function nrItem(t) {
  const external = t.category === "external" || t.category === "internal";
  const raw = nrBig(t.value);
  const dec = external ? 18 : (parseInt(t.decimal, 16) || 18);
  const ts = Number(t.blockTimeStamp ?? t.blockTimestamp);
  return { hash: t.hash, network: "bsc", time: Number.isFinite(ts) && ts > 0 ? iso(ts * 1000) : null, from: t.from || null, to: t.to || t.contractAddress || null,
    value: units(raw.toString(), dec), symbol: external ? "BNB" : (t.asset || "TOKEN"),
    status: Number(t.receiptsStatus) === 0 && t.receiptsStatus != null ? "failed" : "success",
    kind: external ? (raw > 0n ? "native" : "contract") : "token", block: Number(nrBig(t.blockNum)), link: EXPL.bsc + t.hash };
}
async function bscHistory(addr) {
  const url = `https://bsc-mainnet.nodereal.io/v1/${encodeURIComponent(nodeRealKey())}`;
  const from = await nrTransfers(url, addr, "from"); // sequential on purpose: the free key has a per-second CU cap
  const to = await nrTransfers(url, addr, "to");
  const seen = new Set(), items = [];
  for (const t of [...from, ...to]) {
    const k = [t.hash, t.category, t.from, t.to, t.value].join(":");
    if (seen.has(k)) continue; seen.add(k); items.push(nrItem(t));
  }
  return items.sort((x, y) => y.block - x.block).slice(0, 40);
}
async function tronHistory(addr) {
  const h = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const [a, b] = await Promise.all([
    j(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=25&only_confirmed=true`, { headers: h }),
    j(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=25&only_confirmed=true`, { headers: h })]);
  const items = [
    ...(a.data || []).map(t => { const c = t.raw_data?.contract?.[0], v = c?.parameter?.value || {};
      return { hash: t.txID, network: "tron", time: iso(t.block_timestamp), from: v.owner_address ? hexToTron(v.owner_address) : null, to: v.to_address ? hexToTron(v.to_address) : null,
        value: v.amount != null ? units(v.amount, 6) : "0", symbol: "TRX", status: t.ret?.[0]?.contractRet === "SUCCESS" ? "success" : "failed",
        kind: c?.type === "TransferContract" ? "native" : "contract", ts: t.block_timestamp, link: EXPL.tron + t.txID }; }),
    ...(b.data || []).map(t => ({ hash: t.transaction_id, network: "tron", time: iso(t.block_timestamp), from: t.from, to: t.to, value: units(t.value, Number(t.token_info?.decimals) || 6),
      symbol: t.token_info?.symbol || "TRC20", status: "success", kind: "token", ts: t.block_timestamp, link: EXPL.tron + t.transaction_id }))
  ];
  return items.sort((x, y) => y.ts - x.ts).slice(0, 40).map(({ ts, ...r }) => r);
}
async function solHistory(addr) {
  const r = await rpc(process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com", "getSignaturesForAddress", [addr, { limit: 25 }]);
  return r.map(t => ({ hash: t.signature, network: "solana", time: t.blockTime ? iso(t.blockTime * 1000) : null, from: addr, to: null, value: null, symbol: "SOL",
    status: t.err ? "failed" : "success", kind: "contract", block: t.slot, link: EXPL.solana + t.signature }));
}
async function tonHistory(addr) {
  const h = process.env.TONCENTER_API_KEY ? { "X-API-Key": process.env.TONCENTER_API_KEY } : {};
  const r = await j(`https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(addr)}&limit=25`, { headers: h });
  return (r.result || []).map(t => { const m = t.in_msg?.source ? t.in_msg : (t.out_msgs || [])[0] || {};
    return { hash: t.transaction_id?.hash, network: "ton", time: iso(t.utime * 1000), from: m.source || addr, to: m.destination || null, value: m.value != null ? units(m.value, 9) : "0",
      symbol: "TON", status: "success", kind: m.msg_data?.["@type"] === "msg.dataText" || !m.msg_data ? "native" : "contract", link: EXPL.ton + (t.transaction_id?.hash || "") }; });
}

export async function txHistory(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "tx", s.id, 20)) return;
  const p = new URL(req.url, "https://x.invalid").searchParams;
  const q = String(p.get("q") || "").trim(), net = String(p.get("network") || "").toLowerCase(), type = String(p.get("type") || "");
  if (!q || q.length > 120) return send(res, 400, { ok: false, error: "INVALID_QUERY" });
  if (net && !SUPPORTED.includes(net)) return send(res, 400, { ok: false, error: "UNSUPPORTED_NETWORK" });
  try {
    let items = await lookupHash(net, q), mode = "tx", failed = [];
    if (items === null) {
      mode = "address";
      const nets = net ? [net] : SUPPORTED.filter(n => validAddr(n, q));
      if (!nets.length || (net && !validAddr(net, q))) return send(res, 400, { ok: false, error: "INVALID_QUERY" });
      if (!net && nets.every(n => EVM[n])) {
        // Same 0x address exists on every EVM chain: scan all of them in parallel and merge by time.
        const names = Object.keys(EVM);
        const settled = await Promise.allSettled(names.map(n => evmHistory(n, q, true)));
        items = []; failed = [];
        settled.forEach((r, i) => r.status === "fulfilled" ? items.push(...r.value)
          : failed.push({ network: names[i], error: INDEXER_CODES[r.reason?.message] ? r.reason.message : "UPSTREAM_UNAVAILABLE" }));
        if (failed.length) console.error("[txhistory:all]", failed.map(f => f.network + ":" + f.error).join(","));
        if (!items.length && failed.length === names.length) throw new Error(failed[0].error);
        items.sort((x, y) => (Date.parse(y.time) || 0) - (Date.parse(x.time) || 0));
        items = items.slice(0, 60);
      } else {
        const target = net || nets[0];
        items = EVM[target] ? await evmHistory(target, q) : target === "tron" ? await tronHistory(q) : target === "solana" ? await solHistory(q) : await tonHistory(q);
      }
    }
    if (["native", "token", "contract"].includes(type)) items = items.filter(i => i.kind === type);
    return send(res, 200, { ok: true, mode, items, count: items.length, failed });
  } catch (e) {
    const code = INDEXER_CODES[e.message] ? e.message : "UPSTREAM_UNAVAILABLE";
    console.error("[txhistory]", code, e.detail || e.message || ""); // provider text only, never the API key
    return send(res, INDEXER_CODES[code] || 502, { ok: false, error: code });
  }
}
