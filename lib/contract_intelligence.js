// Contract interaction intelligence for EVM contracts.
// Discovers direct transaction callers from Etherscan and classifies them using eth_getCode.
// It does not infer buys/sells or profitability from a contract call.
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { EVM, j, rpc } from "./balances.js";

const CHAIN_ID = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
const EXPLORER = { ethereum: "https://etherscan.io", bsc: "https://bscscan.com", polygon: "https://polygonscan.com", arbitrum: "https://arbiscan.io", base: "https://basescan.org", optimism: "https://optimistic.etherscan.io", avalanche: "https://snowtrace.io" };
const ADDR = /^0x[a-fA-F0-9]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const keyOf = value => String(value || "").toLowerCase();

export function aggregateContractCallers(rows, contractAddress) {
  const contract = keyOf(contractAddress), byAddress = new Map();
  for (const tx of Array.isArray(rows) ? rows : []) {
    const from = keyOf(tx?.from), to = keyOf(tx?.to);
    if (!ADDR.test(from) || from === ZERO || from === contract || to !== contract || tx?.isError === "1") continue;
    const row = byAddress.get(from) || { address: from, transactions: 0, firstSeen: 0, lastSeen: 0, sampleTx: "" };
    const ts = Number(tx.timeStamp) * 1000;
    row.transactions++;
    if (Number.isFinite(ts) && ts > 0) {
      row.firstSeen = row.firstSeen ? Math.min(row.firstSeen, ts) : ts;
      row.lastSeen = Math.max(row.lastSeen, ts);
    }
    if (!row.sampleTx) row.sampleTx = String(tx.hash || "");
    byAddress.set(from, row);
  }
  return [...byAddress.values()].sort((a, b) => b.transactions - a.transactions || b.lastSeen - a.lastSeen);
}

export async function contractIntelligence(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const session = readSession(req);
  if (!session) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "contract-intelligence", session.id, 5)) return;

  const params = new URL(req.url, "https://x.invalid").searchParams;
  const network = String(params.get("network") || "ethereum").toLowerCase();
  const address = String(params.get("address") || "").trim();
  if (!EVM[network] || !ADDR.test(address)) return send(res, 400, { ok: false, error: "INVALID_CONTRACT_OR_NETWORK" });
  const apiKey = String(process.env.ETHERSCAN_API_KEY || "").trim();
  if (!apiKey) return send(res, 503, { ok: false, error: "INDEXER_NOT_CONFIGURED", message: "Set ETHERSCAN_API_KEY in Vercel Environment Variables." });

  try {
    const rpcUrl = process.env["RPC_" + network.toUpperCase()] || EVM[network].rpc;
    const targetCode = await rpc(rpcUrl, "eth_getCode", [address, "latest"]);
    if (!targetCode || targetCode === "0x" || targetCode === "0x0") return send(res, 400, { ok: false, error: "ADDRESS_NOT_CONTRACT" });
    const query = new URLSearchParams({ chainid: String(CHAIN_ID[network]), module: "account", action: "txlist", address, page: "1", offset: "100", sort: "desc", apikey: apiKey });
    const data = await j(`https://api.etherscan.io/v2/api?${query}`);
    let rows = [];
    if (Array.isArray(data.result)) rows = data.result;
    else if (!(data.message === "No transactions found" || data.result === "No transactions found")) {
      const detail = String(data.result || data.message || "INDEXER_ERROR").toLowerCase();
      if (detail.includes("rate limit")) return send(res, 503, { ok: false, error: "INDEXER_RATE_LIMITED" });
      if (detail.includes("invalid api") || detail.includes("apikey")) return send(res, 503, { ok: false, error: "INDEXER_KEY_REJECTED" });
      throw new Error("INDEXER_ERROR");
    }

    const grouped = aggregateContractCallers(rows, address).slice(0, 30);
    const classified = await Promise.all(grouped.map(async candidate => {
      try {
        const code = await rpc(rpcUrl, "eth_getCode", [candidate.address, "latest"]);
        return { ...candidate, classification: code && code !== "0x" && code !== "0x0" ? "CONTRACT" : "EOA" };
      } catch {
        return { ...candidate, classification: "UNKNOWN" };
      }
    }));
    const wallets = classified.filter(x => x.classification === "EOA").slice(0, 20).map(x => ({
      ...x,
      sampleTxUrl: x.sampleTx ? `${EXPLORER[network]}/tx/${x.sampleTx}` : null,
      addressUrl: `${EXPLORER[network]}/address/${x.address}`
    }));
    const contractCallers = classified.filter(x => x.classification === "CONTRACT").length;
    const unknown = classified.filter(x => x.classification === "UNKNOWN").length;
    return send(res, 200, {
      ok: true, network, contract: address,
      source: "Etherscan account txlist + Ethereum-compatible RPC eth_getCode",
      scannedTransactions: rows.length,
      directCallerCount: grouped.length,
      eoaWalletCount: wallets.length,
      contractCallerCount: contractCallers,
      unclassifiedCount: unknown,
      wallets,
      limitations: [
        "Only direct top-level transactions whose `to` address is this contract are counted; router-mediated calls and internal traces may be missing.",
        "EOA means eth_getCode returned empty code at the latest block; smart-account and counterfactual-wallet behavior can complicate this classification.",
        "A contract interaction is not automatically a buy or sell. Wallet PnL is calculated only after a wallet is explicitly saved and its supported swap history is indexed."
      ],
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_429") return send(res, 503, { ok: false, error: "INDEXER_RATE_LIMITED" });
    if (message === "UPSTREAM_403") return send(res, 503, { ok: false, error: "INDEXER_KEY_REJECTED" });
    console.error("[contract-intelligence]", message.slice(0, 120));
    return send(res, 502, { ok: false, error: "CONTRACT_INTELLIGENCE_UNAVAILABLE" });
  }
}
