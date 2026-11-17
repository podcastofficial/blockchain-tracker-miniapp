// PnL engine: pure functions only (no DB, no network) so they can be unit-tested offline.
//   parseEvm / parseHelius / parseTron  -> raw indexer rows  -> normalized swap trades
//   computePnl                          -> trades            -> FIFO realized / unrealized PnL
// Rules: only clean 1-asset-out / 1-asset-in swaps count as trades. Anything else (LP, bridge, plain
// transfers, token<->token with no stable/native leg) is skipped and counted, never guessed.

export const NATIVE_SYM = { ethereum: "ETH", bsc: "BNB", polygon: "POL", arbitrum: "ETH", base: "ETH", optimism: "ETH", avalanche: "AVAX", tron: "TRX", solana: "SOL", ton: "TON" };
const EVM_NETS = ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche"];
const isEvm = n => EVM_NETS.includes(n);

// Stablecoins are the quote currency. Matched by CONTRACT ADDRESS, not symbol, so a scam token named "USDT" is not treated as $1.
const STABLE_ADDR = {
  ethereum: ["0xdac17f958d2ee523a2206206994597c8d4a72f6", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x6b175474e89094c44da98b954eedeac495271d0f"],
  bsc: ["0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0xe9e7cea3dedca5984780bafc599bd69add087d56"],
  polygon: ["0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"],
  arbitrum: ["0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"],
  base: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  optimism: ["0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  avalanche: ["0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
  tron: ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8"],
  solana: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]
};
// Wrapped native coins count as the native coin (so wrap/unwrap nets to zero and WETH trades price like ETH).
const WRAPPED_ADDR = {
  ethereum: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"], bsc: ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"],
  polygon: ["0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"], arbitrum: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1"],
  base: ["0x4200000000000000000000000000000000000006"], optimism: ["0x4200000000000000000000000000000000000006"],
  avalanche: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"], solana: ["So11111111111111111111111111111111111111112"]
};
const norm = (net, a) => isEvm(net) ? String(a || "").toLowerCase() : String(a || "");
const inList = (map, net, a) => (map[net] || []).some(x => norm(net, x) === norm(net, a));
export const isStable = (net, a) => inList(STABLE_ADDR, net, a);
export const isWrapped = (net, a) => inList(WRAPPED_ADDR, net, a);

const short = a => a ? a.slice(0, 4) + "…" + a.slice(-4) : "?";
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Merge raw legs per asset and net them (wrap/unwrap, router refunds and dust cancel out).
function netLegs(entries) {
  const m = new Map();
  for (const e of entries) {
    const c = m.get(e.key) || { ...e, amount: 0, gross: 0 };
    c.amount += e.amount; c.gross += Math.abs(e.amount); m.set(e.key, c);
  }
  return [...m.values()].filter(l => Math.abs(l.amount) > 1e-12 && Math.abs(l.amount) > 1e-6 * l.gross);
}

// legs: net legs of ONE tx for ONE wallet. Returns { trade } or { skip: reason }.
export function buildTrade({ ts, hash, network, wallet, legs, feeNative = 0, priceAt }) {
  const outs = legs.filter(l => l.amount < 0), ins = legs.filter(l => l.amount > 0);
  if (outs.length !== 1 || ins.length !== 1) return { skip: "not_a_simple_swap" };
  const o = outs[0], i = ins[0];
  if (o.key === i.key) return { skip: "same_asset" };
  const rank = l => (l.kind === "stable" ? 0 : l.kind === "native" ? 1 : 2);
  let quote, asset;
  if (rank(o) < 2 && rank(i) < 2) {
    if (o.kind === i.kind) return { skip: "no_asset" };               // stable<->stable
    quote = o.kind === "stable" ? o : i; asset = quote === o ? i : o;  // stable<->native: the native coin is the asset
  } else if (rank(o) === 2 && rank(i) === 2) return { skip: "token_to_token" };
  else { quote = rank(o) < 2 ? o : i; asset = quote === o ? i : o; }

  const nsym = NATIVE_SYM[network];
  const np = priceAt ? priceAt(nsym, ts) : undefined;
  let usd;
  if (quote.kind === "stable") usd = Math.abs(quote.amount);
  else { if (!(np > 0)) return { skip: "price_missing" }; usd = Math.abs(quote.amount) * np; }
  if (!(usd > 0)) return { skip: "zero_value" };
  const feeUsd = feeNative > 0 && np > 0 ? feeNative * np : 0;
  return { trade: {
    id: `${network}:${wallet}:${hash}:${asset.key}`, ts, network, wallet, txHash: hash,
    side: asset === i ? "buy" : "sell",
    token: { symbol: asset.symbol, address: asset.address || null, key: asset.key },
    amount: Math.abs(asset.amount), usdValue: usd, feeUsd
  } };
}

function finish(groups, network, wallet, priceAt) {
  const trades = [], skipped = {};
  for (const g of groups.values()) {
    const r = buildTrade({ ts: g.ts, hash: g.hash, network, wallet, legs: netLegs(g.legs), feeNative: g.fee, priceAt });
    if (r.trade) trades.push(r.trade); else skipped[r.skip] = (skipped[r.skip] || 0) + 1;
  }
  return { trades, skipped };
}
const addTo = (m, hash, ts) => { if (!m.has(hash)) m.set(hash, { hash, ts, legs: [], fee: 0, failed: false }); const g = m.get(hash); if (ts) g.ts = ts; return g; };

// ---------------- EVM (Etherscan V2 txlist + tokentx + txlistinternal) ----------------
export function parseEvm({ network, wallet, txlist = [], tokentx = [], internal = [], priceAt }) {
  const w = wallet.toLowerCase(), nsym = NATIVE_SYM[network], groups = new Map();
  const nativeKey = `${network}:native`;
  const nat = (g, amount) => g.legs.push({ key: nativeKey, symbol: nsym, address: null, kind: "native", amount });
  for (const t of txlist) {
    const g = addTo(groups, t.hash, num(t.timeStamp) * 1000);
    if (t.isError === "1") g.failed = true;
    const v = num(t.value) / 1e18;
    if (String(t.from).toLowerCase() === w) { g.fee = num(t.gasUsed) * num(t.gasPrice) / 1e18; if (v > 0) nat(g, -v); }
    else if (String(t.to).toLowerCase() === w && v > 0) nat(g, v);
  }
  for (const t of internal) {
    if (t.isError === "1") continue;
    const g = addTo(groups, t.hash, num(t.timeStamp) * 1000), v = num(t.value) / 1e18;
    if (v <= 0) continue;
    if (String(t.to).toLowerCase() === w) nat(g, v); else if (String(t.from).toLowerCase() === w) nat(g, -v);
  }
  for (const t of tokentx) {
    const g = addTo(groups, t.hash, num(t.timeStamp) * 1000);
    const amt = num(t.value) / 10 ** (num(t.tokenDecimal) || 18), addr = String(t.contractAddress || "").toLowerCase();
    const sign = String(t.from).toLowerCase() === w ? -1 : String(t.to).toLowerCase() === w ? 1 : 0;
    if (!sign || amt <= 0) continue;
    if (isWrapped(network, addr)) nat(g, sign * amt);
    else g.legs.push({ key: `${network}:${addr}`, symbol: String(t.tokenSymbol || short(addr)).slice(0, 16), address: addr, kind: isStable(network, addr) ? "stable" : "token", amount: sign * amt });
  }
  for (const [h, g] of groups) if (g.failed) groups.delete(h);
  return finish(groups, network, wallet, priceAt);
}

// ---------------- Solana (Helius Enhanced Transactions, type=SWAP) ----------------
export function parseHelius({ wallet, txs = [], priceAt }) {
  const groups = new Map(), network = "solana", nativeKey = "solana:native";
  for (const tx of txs) {
    const s = tx?.events?.swap; if (!s || tx.transactionError) continue;
    const g = addTo(groups, tx.signature, num(tx.timestamp) * 1000);
    if (tx.feePayer === wallet) g.fee = num(tx.fee) / 1e9;
    if (s.nativeInput?.account === wallet) g.legs.push({ key: nativeKey, symbol: "SOL", address: null, kind: "native", amount: -num(s.nativeInput.amount) / 1e9 });
    if (s.nativeOutput?.account === wallet) g.legs.push({ key: nativeKey, symbol: "SOL", address: null, kind: "native", amount: num(s.nativeOutput.amount) / 1e9 });
    const tok = (arr, sign) => { for (const x of arr || []) {
      if (x.userAccount !== wallet) continue;
      const amt = num(x.rawTokenAmount?.tokenAmount) / 10 ** num(x.rawTokenAmount?.decimals);
      if (amt <= 0) continue;
      if (isWrapped(network, x.mint)) g.legs.push({ key: nativeKey, symbol: "SOL", address: null, kind: "native", amount: sign * amt });
      else g.legs.push({ key: `solana:${x.mint}`, symbol: short(x.mint), address: x.mint, kind: isStable(network, x.mint) ? "stable" : "token", amount: sign * amt });
    } };
    tok(s.tokenInputs, -1); tok(s.tokenOutputs, 1);
  }
  return finish(groups, network, wallet, priceAt);
}

// ---------------- Tron (TronGrid TRC20 transfers; only token <-> USDT/USDC swaps are detected) ----------------
export function parseTron({ wallet, transfers = [], priceAt }) {
  const groups = new Map(), network = "tron";
  for (const t of transfers) {
    const g = addTo(groups, t.transaction_id, num(t.block_timestamp));
    const dec = num(t.token_info?.decimals) || 6, amt = num(t.value) / 10 ** dec, addr = t.token_info?.address;
    const sign = t.from === wallet ? -1 : t.to === wallet ? 1 : 0;
    if (!sign || amt <= 0 || !addr) continue;
    g.legs.push({ key: `tron:${addr}`, symbol: String(t.token_info?.symbol || short(addr)).slice(0, 16), address: addr, kind: isStable(network, addr) ? "stable" : "token", amount: sign * amt });
  }
  return finish(groups, network, wallet, priceAt);
}

// ---------------- merge (cache) ----------------
export function mergeTrades(existing, incoming, cap = 500) {
  const m = new Map();
  for (const t of existing || []) m.set(t.id, t);
  for (const t of incoming || []) m.set(t.id, t);
  return [...m.values()].sort((a, b) => b.ts - a.ts).slice(0, cap);
}

// ---------------- FIFO PnL ----------------
// trades: normalized trades (any order, any wallets). sinceTs: only SELLS at/after it count as realized.
// marks: { tokenKey: usdPrice } live prices; tokens without a live price fall back to their last trade price.
export function computePnl(trades, { sinceTs = 0, marks = {} } = {}) {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || (a.side === "buy" ? -1 : 1));
  const books = new Map(), closed = [], pnlById = new Map();
  for (const t of sorted) {
    if (!(t.amount > 0) || !(t.usdValue > 0)) continue;
    const key = t.token.key;
    const b = books.get(key) || { key, symbol: t.token.symbol, lots: [], realized: 0, unknownCost: false, lastPrice: 0 };
    books.set(key, b);
    b.lastPrice = t.usdValue / t.amount;
    const fee = t.feeUsd || 0;
    if (t.side === "buy") { b.lots.push({ qty: t.amount, unit: (t.usdValue + fee) / t.amount }); continue; }
    let rem = t.amount, cost = 0, matched = 0;
    while (rem > t.amount * 1e-9 && b.lots.length) {
      const lot = b.lots[0], take = Math.min(rem, lot.qty);
      cost += take * lot.unit; matched += take; lot.qty -= take; rem -= take;
      if (lot.qty <= 1e-15 || lot.qty < take * 1e-9) b.lots.shift();
    }
    if (rem > t.amount * 1e-6) b.unknownCost = true;              // sold more than we saw bought: cost unknown, never assume 0
    if (matched > 0) {
      const share = matched / t.amount, proceeds = (t.usdValue - fee) * share, pnl = proceeds - cost;
      pnlById.set(t.id, pnl);
      if (t.ts >= sinceTs) {
        b.realized += pnl;
        closed.push({ id: t.id, ts: t.ts, token: b.symbol, tokenKey: key, network: t.network, txHash: t.txHash, pnlUsd: pnl, partial: share < 0.999999 });
      }
    }
  }
  let unrealized = 0, openCost = 0;
  const byToken = [];
  for (const b of books.values()) {
    const qty = b.lots.reduce((a, l) => a + l.qty, 0), cost = b.lots.reduce((a, l) => a + l.qty * l.unit, 0);
    const live = marks[b.key], px = live > 0 ? live : b.lastPrice;
    const unreal = qty > 1e-12 ? qty * px - cost : 0;
    unrealized += unreal; openCost += cost;
    const wins = closed.filter(c => c.tokenKey === b.key);
    if (!wins.length && !(qty > 1e-12) && !b.unknownCost) continue;
    byToken.push({ token: b.symbol, key: b.key, realizedUsd: b.realized, unrealizedUsd: unreal, holding: qty, markSource: qty > 1e-12 ? (live > 0 ? "live" : "last_trade") : null, unknownCost: b.unknownCost });
  }
  byToken.sort((a, b) => Math.abs(b.realizedUsd + b.unrealizedUsd) - Math.abs(a.realizedUsd + a.unrealizedUsd));
  const realized = closed.reduce((a, c) => a + c.pnlUsd, 0);
  const wins = closed.filter(c => c.pnlUsd > 0).length;
  const best = closed.length ? closed.reduce((a, c) => (c.pnlUsd > a.pnlUsd ? c : a)) : null;
  const worst = closed.length ? closed.reduce((a, c) => (c.pnlUsd < a.pnlUsd ? c : a)) : null;
  const view = c => c && { token: c.token, pnlUsd: c.pnlUsd, txHash: c.txHash, network: c.network };
  const inWindow = sorted.filter(t => t.ts >= sinceTs).reverse().slice(0, 50)
    .map(t => ({ ts: t.ts, network: t.network, side: t.side, token: t.token.symbol, amount: t.amount, usdValue: t.usdValue, txHash: t.txHash, pnlUsd: t.side === "sell" && pnlById.has(t.id) ? pnlById.get(t.id) : null }));
  return {
    summary: { realizedUsd: realized, unrealizedUsd: unrealized, totalUsd: realized + unrealized, winRate: closed.length ? wins / closed.length : null,
      closedTrades: closed.length, trades: sorted.filter(t => t.ts >= sinceTs).length, best: view(best), worst: view(worst) },
    byToken, trades: inWindow, unknownCostTokens: byToken.filter(t => t.unknownCost).length
  };
}
