// Community Crypto Monitor — Phase 3: read-only data lookups for detected addresses and transaction hashes.
// Every field that cannot be fetched stays null and is listed in `unavailable`; nothing is guessed or invented.
import { EVM, fetchBalance, fetchPrices, rpc, j } from "./balances.js";
import { tokenSnapshot } from "./dex.js";
import { NETWORKS } from "./address.js";

const SOL_SYSTEM = "11111111111111111111111111111111";
const rpcUrl = net => process.env["RPC_" + net.toUpperCase()] || EVM[net].rpc;
const solRpc = () => process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com";
const tronPost = (path, body) => j("https://api.trongrid.io" + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...(process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {}) },
  body: JSON.stringify(body)
});
const settle = p => Promise.resolve(p).then(v => ({ ok: true, v }), () => ({ ok: false }));
export const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("TIMEOUT")), ms); })]).finally(() => clearTimeout(t)); };

// ---- ABI helpers (ERC-20 name()/symbol()/decimals() probes) ----
export function decodeAbiString(hex) {
  const h = String(hex || "").replace(/^0x/, ""); if (h.length < 64) return null;
  let bytes;
  if (h.length === 64) bytes = Buffer.from(h, "hex");                       // bytes32 (older tokens such as MKR)
  else {
    const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16);
    if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0 || len > 128 || h.length < off + 64 + len * 2) return null;
    bytes = Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex");
  }
  const s = bytes.toString("utf8").replace(/\0+$/g, "").trim();
  return s && s.length <= 64 && /^[\x20-\x7E\u00A0-\uFFFF]+$/.test(s) ? s : null;
}
export const decodeUint = hex => { const h = String(hex || "").replace(/^0x/, ""); return h.length >= 2 && /^[0-9a-fA-F]+$/.test(h) ? Number(BigInt("0x" + h)) : null; };

const DEX_CHAIN = { ethereum: "ethereum", bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", base: "base", solana: "solana", tron: "tron" };
async function addDexInfo(out) {
  const r = await settle(tokenSnapshot(DEX_CHAIN[out.network], out.address));
  if (!r.ok) { out.unavailable.push("market data"); return; }
  if (!r.v) { out.notes.push("No trading pair found on DEX Screener"); return; }
  out.token = r.v; out.source.push("DEX Screener");
  out.name = out.name || r.v.base.name || null; out.symbol = out.symbol || r.v.base.symbol || null; out.kind = "token";
}
async function addNative(out, bal) {
  const prices = await fetchPrices().catch(() => ({}));
  const usd = prices[bal.symbol]?.usd;
  out.native = { symbol: bal.symbol, amount: bal.native, usd: usd ? bal.native * usd : null };
  out.stables = (bal.tokens || []).filter(t => t.amount > 0).map(t => ({ symbol: t.symbol, amount: t.amount }));
}

async function evm(out) {
  const url = rpcUrl(out.network);
  const code = await settle(rpc(url, "eth_getCode", [out.address, "latest"]));
  if (!code.ok) { out.unavailable.push("account type"); return addDexInfo(out); }
  out.source.push("public RPC");
  if (/^0x0*$/.test(code.v || "0x")) {                                      // no bytecode: externally owned account
    out.kind = "wallet";
    const b = await settle(fetchBalance(out.network, out.address));
    if (b.ok) await addNative(out, b.v); else out.unavailable.push("balance");
    return;
  }
  out.kind = "contract";
  const call = data => settle(rpc(url, "eth_call", [{ to: out.address, data }, "latest"]));
  const [sym, nm, dec] = await Promise.all([call("0x95d89b41"), call("0x06fdde03"), call("0x313ce567")]);
  const symbol = sym.ok ? decodeAbiString(sym.v) : null, decimals = dec.ok ? decodeUint(dec.v) : null;
  if (symbol && decimals !== null && decimals <= 36) { out.kind = "token"; out.symbol = symbol; out.name = nm.ok ? decodeAbiString(nm.v) : null; out.decimals = decimals; }
  await addDexInfo(out);
}

async function sol(out) {
  const acc = await settle(rpc(solRpc(), "getAccountInfo", [out.address, { encoding: "jsonParsed" }]));
  if (!acc.ok) { out.unavailable.push("account type"); return addDexInfo(out); }
  out.source.push("public RPC");
  const v = acc.v?.value;
  if (!v) { out.kind = "wallet"; out.notes.push("No on-chain account found yet (unfunded address)"); out.native = { symbol: "SOL", amount: 0, usd: 0 }; return; }
  if (v.executable) { out.kind = "contract"; out.notes.push("Executable program"); return addDexInfo(out); }
  if (v.data?.parsed?.type === "mint") {
    out.kind = "token"; const info = v.data.parsed.info || {};
    out.decimals = info.decimals ?? null; out.supply = info.supply !== undefined && info.decimals !== undefined ? Number(info.supply) / 10 ** info.decimals : null;
    return addDexInfo(out);
  }
  if (v.owner === SOL_SYSTEM) {
    out.kind = "wallet"; const b = await settle(fetchBalance("solana", out.address));
    if (b.ok) await addNative(out, b.v); else out.unavailable.push("balance");
    return;
  }
  out.kind = "contract"; out.notes.push("Account owned by program " + String(v.owner).slice(0, 6) + "…"); await addDexInfo(out);
}

async function tron(out) {
  const c = await settle(tronPost("/wallet/getcontract", { value: out.address, visible: true }));
  if (!c.ok) { out.unavailable.push("account type"); return addDexInfo(out); }
  out.source.push("TronGrid");
  if (c.v && (c.v.bytecode || c.v.contract_address)) { out.kind = "contract"; return addDexInfo(out); }
  out.kind = "wallet"; const b = await settle(fetchBalance("tron", out.address));
  if (b.ok) await addNative(out, b.v); else out.unavailable.push("balance");
}

export async function enrichAddress(network, address) {
  const out = { kind: "unknown", network, address, name: null, symbol: null, native: null, stables: [], token: null, notes: [], unavailable: [], source: [], updatedAt: new Date().toISOString() };
  try {
    const fam = NETWORKS[network].family;
    await withTimeout(fam === "evm" ? evm(out) : fam === "solana" ? sol(out) : tron(out), 6500);
  } catch { if (!out.unavailable.length) out.unavailable.push("on-chain data"); }
  return out;
}

// ---- Transactions ----
const hexNum = h => h ? Number(BigInt(h)) : null;
async function evmTx(hash, nets) {
  const found = await Promise.all(nets.map(async n => ({ n, r: await settle(rpc(rpcUrl(n), "eth_getTransactionByHash", [hash])) })));
  const hit = found.find(x => x.r.ok && x.r.v);
  if (!hit) return found.every(x => !x.r.ok) ? { status: "unavailable" } : { status: "not_found" };
  const { n, r: { v: tx } } = hit, url = rpcUrl(n);
  const rc = await settle(rpc(url, "eth_getTransactionReceipt", [hash]));
  const out = { network: n, status: "pending", from: tx.from, to: tx.to || null, value: { amount: Number(BigInt(tx.value || "0x0")) / 1e18, symbol: EVM[n].symbol } };
  if (rc.ok && rc.v?.blockNumber) {
    out.status = rc.v.status === "0x1" ? "success" : "failed"; out.block = hexNum(rc.v.blockNumber);
    const blk = await settle(rpc(url, "eth_getBlockByNumber", [rc.v.blockNumber, false]));
    if (blk.ok && blk.v?.timestamp) out.time = hexNum(blk.v.timestamp) * 1000;
  }
  return out;
}
async function solTx(sig) {
  const r = await settle(rpc(solRpc(), "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]));
  if (!r.ok) return { status: "unavailable" };
  if (!r.v) return { status: "not_found" };
  return { network: "solana", status: r.v.meta?.err ? "failed" : "success", block: r.v.slot, time: r.v.blockTime ? r.v.blockTime * 1000 : null,
    from: r.v.transaction?.message?.accountKeys?.[0] || null, fee: r.v.meta?.fee !== undefined ? { amount: r.v.meta.fee / 1e9, symbol: "SOL" } : null };
}
async function tronTx(hash) {
  const [info, tx] = await Promise.all([settle(tronPost("/wallet/gettransactioninfobyid", { value: hash })), settle(tronPost("/wallet/gettransactionbyid", { value: hash, visible: true }))]);
  if (!info.ok && !tx.ok) return { status: "unavailable" };
  const hasTx = tx.ok && tx.v?.txID, hasInfo = info.ok && info.v?.id;
  if (!hasTx && !hasInfo) return { status: "not_found" };
  const ret = tx.v?.ret?.[0]?.contractRet, p = tx.v?.raw_data?.contract?.[0]?.parameter?.value || {};
  const out = { network: "tron", status: !hasInfo ? "pending" : (ret && ret !== "SUCCESS") || (info.v.receipt?.result && info.v.receipt.result !== "SUCCESS") ? "failed" : "success",
    block: info.v?.blockNumber ?? null, time: info.v?.blockTimeStamp ?? null, from: p.owner_address || null, to: p.to_address || null,
    fee: info.v?.fee !== undefined ? { amount: info.v.fee / 1e6, symbol: "TRX" } : null };
  if (p.amount !== undefined && p.to_address) out.value = { amount: p.amount / 1e6, symbol: "TRX" };
  return out;
}
export async function enrichTx(family, hash, enabledNets = []) {
  const base = { hash, family, updatedAt: new Date().toISOString() };
  try {
    const nets = (enabledNets.length ? enabledNets : Object.keys(NETWORKS)).filter(n => NETWORKS[n]?.family === family && (family !== "evm" || EVM[n]));
    const r = await withTimeout(family === "evm" ? evmTx(hash, nets) : family === "solana" ? solTx(hash) : tronTx(hash), 6500);
    return { ...base, ...r };
  } catch { return { ...base, status: "unavailable" }; }
}
