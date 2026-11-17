// Deposit auto-detect (Part 2): finds USDT payments sent to the receiving address WITHOUT the user pasting a tx hash.
//
// How it works
//  - Every open invoice has a unique amount (plan price + micro-suffix), so an incoming USDT transfer with exactly that amount,
//    sent inside the invoice window, identifies the invoice.
//  - BEP20: eth_getLogs on the USDT contract filtered by recipient. TRC20: TronGrid "transfers to address" endpoint.
//  - A match is NEVER trusted on its own: it is re-verified with verifyOnChain() (same checks as the manual Verify button),
//    then activated with confirmPayment() (same transaction as manual / recheck path, so referral + points stay consistent).
//  - Not enough confirmations yet -> the invoice is parked as 'verifying' with the tx hash, and recheckPayments() finishes it.
//  - Invoices that expired in the last 30 minutes are still scanned, but only a transfer made INSIDE the invoice window counts.
//
// Runs from: the 5-minute maintenance worker, GET /api/cron/deposits (can be hit every minute), and the app's
// GET /api/subscription/payment-status poll (throttled per chain).
import { db } from "./db.js";
import { CFG, TRANSFER_SIG, toUnits, fetchJson, bscRpc, verifyOnChain } from "./chain.js";
import { confirmPayment } from "./payments.js";

export const DEPOSIT_ENABLED = String(process.env.DEPOSIT_AUTODETECT ?? "1") !== "0";
const GRACE_MIN = 30;                 // keep scanning an invoice this long after it expired
const TOL_MS = 15000;                 // clock skew tolerance between DB time and block time
const BSC_CHUNK = Math.max(500, parseInt(process.env.BSC_LOGS_CHUNK || "3000", 10) || 3000);
const BSC_MAX_BLOCKS = Math.max(5000, parseInt(process.env.BEP20_SCAN_MAX_BLOCKS || "120000", 10) || 120000);
const ONDEMAND_MIN_GAP_MS = 6000;
const lastOnDemand = new Map();       // chain -> timestamp of the last on-demand scan

const hex = n => "0x" + n.toString(16);
const padTopic = addr => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// ---- pure helpers (unit-tested) ----------------------------------------------------------------------------------------

// Which open invoice does this transfer pay? Exact amount + inside the invoice window + same receiving address.
// Returns the invoice, or null (no match, or ambiguous: two invoices could claim it -> leave to manual verify).
export function matchTransfer(invoices, { to, units, tsMs }, decimals) {
  const hits = invoices.filter(inv =>
    String(inv.receiving_address).toLowerCase() === String(to).toLowerCase() &&
    toUnits(inv.expected_amount, decimals) === units &&
    tsMs >= new Date(inv.created_at).getTime() - TOL_MS &&
    tsMs <= new Date(inv.expires_at).getTime() + TOL_MS);
  return hits.length === 1 ? hits[0] : null;
}

export function bscFromBlock(latest, blockTimeSec, oldestCreatedMs, nowMs = Date.now()) {
  const windowSec = Math.max(60, (nowMs - oldestCreatedMs) / 1000 + 90);
  const blocks = Math.min(BSC_MAX_BLOCKS, Math.ceil(windowSec / Math.max(0.2, blockTimeSec)) + 100);
  return Math.max(0, latest - blocks);
}

// ---- settle: verify a candidate on-chain, then activate or park it ---------------------------------------------------------

async function settle(inv, txHash, tsMs, out) {
  let v;
  try { v = await verifyOnChain(inv.chain, txHash, inv); } catch { out.errors++; return; }
  if (v.state === "rejected") { out.rejected++; return; }
  if (v.state === "pending") {
    try {
      await db().query(
        `UPDATE subscription_payments SET tx_hash=$2, status='verifying', confirmations=$3, failure_reason=NULL, updated_at=NOW()
          WHERE id=$1 AND tx_hash IS NULL AND status IN ('pending','expired')`, [inv.id, txHash, v.confirmations ?? 0]);
      out.waiting++;
    } catch (e) { if (e.code === "23505") out.duplicate++; else out.errors++; }
    return;
  }
  const paid = v.paidAt ? new Date(v.paidAt).getTime() : tsMs;
  if (paid < new Date(inv.created_at).getTime() - TOL_MS || paid > new Date(inv.expires_at).getTime() + TOL_MS) { out.outsideWindow++; return; }
  try {
    const r = await confirmPayment(inv, txHash, v.confirmations);
    if (r.status === "confirmed") out.confirmed++;
  } catch (e) { if (e.code === "23505") out.duplicate++; else out.errors++; }
}

// ---- BEP20 ---------------------------------------------------------------------------------------------------------------

export async function scanBep20(invs, deadline, out, settleFn = settle) {
  const addrs = [...new Set(invs.map(i => String(i.receiving_address).toLowerCase()))];
  const latest = parseInt(await bscRpc("eth_blockNumber", []), 16);
  const probe = Math.min(1000, latest);
  const [bNow, bOld] = await Promise.all([bscRpc("eth_getBlockByNumber", [hex(latest), false]), bscRpc("eth_getBlockByNumber", [hex(latest - probe), false])]);
  const blockTime = probe ? (parseInt(bNow.timestamp, 16) - parseInt(bOld.timestamp, 16)) / probe : 3;
  const oldest = Math.min(...invs.map(i => new Date(i.created_at).getTime()));
  const from = bscFromBlock(latest, blockTime, oldest);
  const tsCache = new Map();
  const blockTs = async bn => {
    if (!tsCache.has(bn)) tsCache.set(bn, parseInt((await bscRpc("eth_getBlockByNumber", [bn, false])).timestamp, 16) * 1000);
    return tsCache.get(bn);
  };
  const seen = new Set();
  for (const addr of addrs) {
    const mine = invs.filter(i => String(i.receiving_address).toLowerCase() === addr);
    for (let start = from; start <= latest; start += BSC_CHUNK) {
      if (Date.now() > deadline) return;
      const end = Math.min(latest, start + BSC_CHUNK - 1);
      const logs = await bscRpc("eth_getLogs", [{ address: CFG.BEP20.contract, fromBlock: hex(start), toBlock: hex(end), topics: ["0x" + TRANSFER_SIG, null, padTopic(addr)] }]);
      for (const l of logs || []) {
        if (l.topics?.length !== 3 || seen.has(l.transactionHash + ":" + l.logIndex)) continue;
        seen.add(l.transactionHash + ":" + l.logIndex);
        const units = BigInt(l.data);
        if (!mine.some(i => toUnits(i.expected_amount, CFG.BEP20.decimals) === units)) continue;   // cheap pre-filter: no block lookup
        const tsMs = await blockTs(l.blockNumber);
        const inv = matchTransfer(mine, { to: addr, units, tsMs }, CFG.BEP20.decimals);
        if (inv) await settleFn(inv, l.transactionHash, tsMs, out);
        else out.unmatched++;
      }
    }
  }
}

// ---- TRC20 ---------------------------------------------------------------------------------------------------------------

export async function scanTrc20(invs, deadline, out, settleFn = settle) {
  const headers = {};
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  const addrs = [...new Set(invs.map(i => i.receiving_address))];
  for (const addr of addrs) {
    if (Date.now() > deadline) return;
    const mine = invs.filter(i => i.receiving_address === addr);
    const minTs = Math.min(...mine.map(i => new Date(i.created_at).getTime())) - 90000;
    const url = `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&order_by=block_timestamp,asc` +
      `&contract_address=${CFG.TRC20.contract}&min_timestamp=${minTs}`;
    const j = await fetchJson(url, { headers });
    for (const t of j?.data || []) {
      if (t.type && t.type !== "Transfer") continue;
      if (t.to !== addr || (t.token_info?.address && t.token_info.address !== CFG.TRC20.contract)) continue;
      let units; try { units = BigInt(t.value); } catch { continue; }
      const inv = matchTransfer(mine, { to: addr, units, tsMs: Number(t.block_timestamp) }, CFG.TRC20.decimals);
      if (inv) await settleFn(inv, t.transaction_id, Number(t.block_timestamp), out);
      else out.unmatched++;
    }
  }
}

// ---- entry points --------------------------------------------------------------------------------------------------------

export async function scanDeposits({ budgetMs = 20000, paymentId = null, userId = null } = {}) {
  const out = { enabled: DEPOSIT_ENABLED, candidates: 0, confirmed: 0, waiting: 0, rejected: 0, duplicate: 0, outsideWindow: 0, unmatched: 0, errors: 0 };
  if (!DEPOSIT_ENABLED) return out;
  const params = [GRACE_MIN]; let extra = "";
  if (paymentId) { params.push(paymentId); extra += ` AND id=$${params.length}`; }
  if (userId) { params.push(userId); extra += ` AND user_id=$${params.length}`; }
  const invs = (await db().query(
    `SELECT id, user_id, chain, plan_code, expected_amount::text AS expected_amount, receiving_address, created_at, expires_at
       FROM subscription_payments
      WHERE tx_hash IS NULL AND status IN ('pending','expired') AND expires_at > NOW() - ($1 || ' minutes')::interval${extra}
      ORDER BY created_at ASC LIMIT 200`, params)).rows;
  out.candidates = invs.length;
  if (!invs.length) return out;
  const deadline = Date.now() + budgetMs;
  const run = async (chain, fn) => {
    const list = invs.filter(i => i.chain === chain);
    if (!list.length) return;
    try { await fn(list, deadline, out); } catch { out.errors++; }
  };
  await Promise.all([run("BEP20", scanBep20), run("TRC20", scanTrc20)]);
  return out;
}

// On-demand scan for one invoice (the app polls this). Throttled per chain so polling cannot hammer the RPC / TronGrid.
export async function scanDepositFor(paymentId, userId, chain) {
  const last = lastOnDemand.get(chain) || 0;
  if (Date.now() - last < ONDEMAND_MIN_GAP_MS) return { throttled: true };
  lastOnDemand.set(chain, Date.now());
  return scanDeposits({ budgetMs: 8000, paymentId, userId });
}

export async function cronDeposits(req, res, { authorized, send }) {
  if (!authorized(req)) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  return send(res, 200, { ok: true, deposits: await scanDeposits({ budgetMs: 25000 }) });
}
