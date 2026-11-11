import { EVM, rpc, j } from "./balances.js";
import { send, methodNotAllowed } from "./http.js";

const timed = async fn => { const t = Date.now(); const block = await fn(); return { status: "online", block, ms: Date.now() - t }; };
const CHECKS = {
  ...Object.fromEntries(Object.keys(EVM).map(n => [n, () => timed(async () =>
    parseInt(await rpc(process.env["RPC_" + n.toUpperCase()] || EVM[n].rpc, "eth_blockNumber", []), 16))])),
  tron: () => timed(async () => (await j("https://api.trongrid.io/wallet/getnowblock", { method: "POST" })).block_header.raw_data.number),
  solana: () => timed(() => rpc(process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com", "getSlot", [])),
  ton: () => timed(async () => (await j("https://toncenter.com/api/v2/getMasterchainInfo")).result.last.seqno)
};

let cache = { t: 0, data: null };
export async function networkStatus(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!cache.data || Date.now() - cache.t > 30000) {
    const names = Object.keys(CHECKS);
    const out = await Promise.all(names.map(n => CHECKS[n]().catch(() => ({ status: "offline" }))));
    cache = { t: Date.now(), data: Object.fromEntries(names.map((n, i) => [n, out[i]])) };
  }
  res.setHeader("Cache-Control", "public, s-maxage=30");
  return send(res, 200, { ok: true, networks: cache.data, checkedAt: new Date(cache.t).toISOString() });
}
