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
async function evmHistory(net, addr) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("INDEXER_NOT_CONFIGURED");
  const base = `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID[net]}&address=${addr}&page=1&offset=25&sort=desc&apikey=${encodeURIComponent(key)}`;
  const [a, b] = await Promise.all([j(base + "&module=account&action=txlist"), j(base + "&module=account&action=tokentx")]);
  const arr = r => Array.isArray(r.result) ? r.result : (r.message === "No transactions found" ? [] : (() => { throw new Error("INDEXER_ERROR"); })());
  const items = [
    ...arr(a).map(t => ({ hash: t.hash, network: net, time: iso(t.timeStamp * 1000), from: t.from, to: t.to || t.contractAddress || null, value: units(t.value, 18), symbol: NATIVE[net],
      status: t.isError === "1" ? "failed" : "success", kind: kindOf(false, t.input), block: Number(t.blockNumber), link: EXPL[net] + t.hash })),
    ...arr(b).map(t => ({ hash: t.hash, network: net, time: iso(t.timeStamp * 1000), from: t.from, to: t.to, value: units(t.value, Number(t.tokenDecimal) || 18), symbol: t.tokenSymbol,
      status: "success", kind: "token", block: Number(t.blockNumber), link: EXPL[net] + t.hash }))
  ];
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
    let items = await lookupHash(net, q), mode = "tx";
    if (items === null) {
      mode = "address";
      const nets = net ? [net] : SUPPORTED.filter(n => validAddr(n, q));
      if (!nets.length || (net && !validAddr(net, q))) return send(res, 400, { ok: false, error: "INVALID_QUERY" });
      // Same 0x address exists on every EVM chain: require the user to choose one, to keep upstream usage low.
      const target = net || (nets.every(n => EVM[n]) ? "ethereum" : nets[0]);
      items = EVM[target] ? await evmHistory(target, q) : target === "tron" ? await tronHistory(q) : target === "solana" ? await solHistory(q) : await tonHistory(q);
    }
    if (["native", "token", "contract"].includes(type)) items = items.filter(i => i.kind === type);
    return send(res, 200, { ok: true, mode, items, count: items.length });
  } catch (e) {
    const code = e.message === "INDEXER_NOT_CONFIGURED" ? "INDEXER_NOT_CONFIGURED" : "UPSTREAM_UNAVAILABLE";
    return send(res, code === "INDEXER_NOT_CONFIGURED" ? 503 : 502, { ok: false, error: code });
  }
}
