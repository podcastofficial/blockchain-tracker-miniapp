// Pure parsers: indexer rows of a token's DEX pool -> BUY / SELL trades. No imports, so they are unit-testable offline.
//   Solana : Helius Enhanced Transactions (type=SWAP) of the pool/bonding-curve account
//   Tron   : TronGrid TRC20 transfers of the pool contract (token leg + stable/WTRX leg must flow in opposite directions)
//   TON    : TONCenter v3 jetton transfers of the pool (BETA: direction only, USD is an estimate)
// Anything that is not a clean swap (liquidity add/remove, plain transfer, unknown quote token) is skipped and counted.

export const SOL_WSOL = "So11111111111111111111111111111111111111112";
export const SOL_STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };
export const TRON_STABLES = { TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "USDT", TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: "USDC" };
export const TRON_WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const rawAmt = x => num(x?.rawTokenAmount?.tokenAmount) / 10 ** num(x?.rawTokenAmount?.decimals);
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

// ---------------- Solana ----------------
export function parseSolanaSwaps(txs, mint, solUsd = 0) {
  const trades = [], skipped = {};
  for (const tx of Array.isArray(txs) ? txs : []) {
    const s = tx?.events?.swap;
    if (!s || tx.transactionError) { bump(skipped, "not_swap"); continue; }
    const got = (s.tokenOutputs || []).find(x => x.mint === mint), gave = (s.tokenInputs || []).find(x => x.mint === mint);
    if (!!got === !!gave) { bump(skipped, got ? "both_sides" : "other_token"); continue; }
    const buy = !!got, leg = buy ? got : gave;
    const tokenAmount = rawAmt(leg);
    if (!(tokenAmount > 0)) { bump(skipped, "zero_amount"); continue; }
    // the OTHER side is the quote: what the trader paid (buy) or received (sell)
    const nat = buy ? s.nativeInput : s.nativeOutput, toks = (buy ? s.tokenInputs : s.tokenOutputs) || [];
    let sol = num(nat?.amount) / 1e9, stable = 0, stableSym = "";
    for (const x of toks) {
      if (x.mint === mint) continue;
      if (x.mint === SOL_WSOL) sol += rawAmt(x);
      else if (SOL_STABLES[x.mint]) { stable += rawAmt(x); stableSym = SOL_STABLES[x.mint]; }
    }
    let quoteAmount, quoteSymbol, usd;
    if (sol > 0) { quoteAmount = sol; quoteSymbol = "SOL"; usd = sol * solUsd; }
    else if (stable > 0) { quoteAmount = stable; quoteSymbol = stableSym; usd = stable; }
    else { bump(skipped, "unknown_quote"); continue; }
    trades.push({ key: tx.signature, ts: num(tx.timestamp) * 1000, side: buy ? "BUY" : "SELL", tokenAmount, quoteAmount, quoteSymbol, usd,
      trader: leg.userAccount || tx.feePayer || "", txId: tx.signature });
  }
  return { trades, skipped };
}

// ---------------- Tron ----------------
export function parseTronPool(transfers, { pool, token, trxUsd = 0 }) {
  const byTx = new Map(), trades = [], skipped = {};
  for (const x of Array.isArray(transfers) ? transfers : []) {
    if (!byTx.has(x.transaction_id)) byTx.set(x.transaction_id, []);
    byTx.get(x.transaction_id).push(x);
  }
  for (const [id, xs] of byTx) {
    let tokIn = 0, tokOut = 0, qIn = 0, qOut = 0, qUsdIn = 0, qUsdOut = 0, qSym = "", trader = "", ts = 0;
    for (const x of xs) {
      const a = x.token_info?.address, amt = num(x.value) / 10 ** (num(x.token_info?.decimals) || 6);
      ts = Math.max(ts, num(x.block_timestamp));
      const into = x.to === pool, outof = x.from === pool;
      if (!into && !outof) continue;
      if (a === token) { if (into) { tokIn += amt; trader = trader || x.from; } else { tokOut += amt; trader = trader || x.to; } }
      else if (TRON_STABLES[a] || a === TRON_WTRX) {
        const usd = TRON_STABLES[a] ? amt : amt * trxUsd; qSym = TRON_STABLES[a] || "TRX";
        if (into) { qIn += amt; qUsdIn += usd; } else { qOut += amt; qUsdOut += usd; }
      }
    }
    // BUY: token leaves the pool and quote enters it. SELL: token enters the pool and quote leaves it.
    // Liquidity add (both enter) / remove (both leave) / plain transfers fail this test and are skipped.
    if (tokOut > 0 && tokIn === 0 && qIn > 0 && qOut === 0) trades.push({ key: id, ts, side: "BUY", tokenAmount: tokOut, quoteAmount: qIn, quoteSymbol: qSym, usd: qUsdIn, trader, txId: id });
    else if (tokIn > 0 && tokOut === 0 && qOut > 0 && qIn === 0) trades.push({ key: id, ts, side: "SELL", tokenAmount: tokIn, quoteAmount: qOut, quoteSymbol: qSym, usd: qUsdOut, trader, txId: id });
    else bump(skipped, tokIn + tokOut > 0 ? "not_a_swap" : "other_token");
  }
  return { trades, skipped };
}

// ---------------- TON (BETA) ----------------
// Friendly (EQ.../UQ... base64url) or raw (0:hex) address -> lowercase 64-hex account hash, so both forms can be compared.
export function tonHash(addr) {
  const a = String(addr || "").trim();
  const raw = a.match(/^-?\d+:([0-9a-fA-F]{64})$/);
  if (raw) return raw[1].toLowerCase();
  try { const b = Buffer.from(a.replace(/-/g, "+").replace(/_/g, "/"), "base64"); if (b.length === 36) return b.subarray(2, 34).toString("hex"); } catch { /* fallthrough */ }
  return "";
}
// Direction only: tokens leaving the pool = BUY, tokens entering it = SELL. The quote leg is not visible in jetton transfers,
// so USD is token amount x current DEX price (estimate) and liquidity add/remove can look like a trade. Hence "beta".
export function parseTonJettons(rows, { pool, priceUsd = 0, decimals = 9 }) {
  const p = tonHash(pool), trades = [], skipped = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const src = tonHash(r.source), dst = tonHash(r.destination), amt = num(r.amount) / 10 ** decimals;
    if (!(amt > 0) || (src !== p && dst !== p) || src === dst) { bump(skipped, "not_pool_transfer"); continue; }
    const buy = src === p;
    trades.push({ key: r.transaction_hash, ts: num(r.transaction_now) * 1000, side: buy ? "BUY" : "SELL", tokenAmount: amt, quoteAmount: amt * priceUsd, quoteSymbol: "USD (est.)",
      usd: amt * priceUsd, trader: buy ? r.destination : r.source, txId: r.transaction_hash, estimate: true });
  }
  return { trades, skipped };
}
