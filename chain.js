// Independent on-chain USDT verification (BEP20 via BSC RPC, TRC20 via TronGrid).
// Never trusts client data: checks contract, recipient, exact amount, success, confirmations, tx time.

const TRANSFER_SIG = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CFG = {
  BEP20: {
    contract: "0x55d398326f99059ff775485246999027b3197955", // BSC-USD (USDT)
    decimals: 18,
    minConf: Number(process.env.BEP20_MIN_CONFIRMATIONS || 15)
  },
  TRC20: {
    contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // USDT on Tron
    decimals: 6
  }
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function tronToHex20(addr) {
  let n = 0n;
  for (const c of addr) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("BAD_BASE58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(50, "0"); // 25 bytes: 0x41 + 20 + 4 checksum
  return hex.slice(2, 42).toLowerCase();
}

function toUnits(amountStr, decimals) {
  const [w, f = ""] = String(amountStr).split(".");
  return BigInt(w + f.padEnd(decimals, "0").slice(0, decimals));
}

async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error("UPSTREAM_" + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function bscRpc(method, params) {
  const url = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
  const j = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (j.error) throw new Error("RPC_ERROR");
  return j.result;
}

async function verifyBep20(txHash, payment) {
  const rc = await bscRpc("eth_getTransactionReceipt", [txHash]);
  if (!rc) return { state: "pending", reason: "TX_NOT_FOUND_YET" };
  if (rc.status !== "0x1") return { state: "rejected", reason: "TX_FAILED" };
  const latest = parseInt(await bscRpc("eth_blockNumber", []), 16);
  const bn = parseInt(rc.blockNumber, 16);
  const confirmations = Math.max(0, latest - bn + 1);
  const want = toUnits(payment.expected_amount, CFG.BEP20.decimals);
  const to = payment.receiving_address.toLowerCase().replace(/^0x/, "");
  const hit = (rc.logs || []).find(l =>
    l.address.toLowerCase() === CFG.BEP20.contract &&
    l.topics?.[0]?.replace(/^0x/, "") === TRANSFER_SIG &&
    l.topics.length === 3 &&
    l.topics[2].slice(-40).toLowerCase() === to &&
    BigInt(l.data) === want);
  if (!hit) return { state: "rejected", reason: "NO_MATCHING_USDT_TRANSFER" };
  const blk = await bscRpc("eth_getBlockByNumber", [rc.blockNumber, false]);
  const paidAt = new Date(parseInt(blk.timestamp, 16) * 1000);
  if (confirmations < CFG.BEP20.minConf) return { state: "pending", reason: "WAITING_CONFIRMATIONS", confirmations };
  return { state: "confirmed", confirmations, paidAt };
}

async function verifyTrc20(txHash, payment) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  // Solidity node only returns solidified (irreversibly confirmed) transactions.
  const info = await fetchJson("https://api.trongrid.io/walletsolidity/gettransactioninfobyid", {
    method: "POST", headers, body: JSON.stringify({ value: txHash })
  });
  if (!info || !info.id) return { state: "pending", reason: "WAITING_CONFIRMATIONS" };
  if (info.receipt?.result !== "SUCCESS") return { state: "rejected", reason: "TX_FAILED" };
  const want = toUnits(payment.expected_amount, CFG.TRC20.decimals);
  const contractHex = tronToHex20(CFG.TRC20.contract);
  const toHex = tronToHex20(payment.receiving_address);
  const hit = (info.log || []).find(l =>
    l.address.toLowerCase() === contractHex &&
    l.topics?.[0]?.toLowerCase() === TRANSFER_SIG &&
    l.topics.length === 3 &&
    l.topics[2].slice(-40).toLowerCase() === toHex &&
    BigInt("0x" + l.data) === want);
  if (!hit) return { state: "rejected", reason: "NO_MATCHING_USDT_TRANSFER" };
  return { state: "confirmed", confirmations: 19, paidAt: new Date(info.blockTimeStamp) };
}

export function verifyOnChain(chain, txHash, payment) {
  return chain === "BEP20" ? verifyBep20(txHash, payment) : verifyTrc20(txHash, payment);
}
