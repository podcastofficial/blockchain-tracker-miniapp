# Blockchain Tracker Mini App — Feature Roadmap (10 Parts)

Saare 21 options 10 parts me baante gaye hain. Har part ek ke baad ek banega.
**Part 1 BUILD HO CHUKA HAI (neeche "Part 1 — Build status" dekho).** Baaki parts ka sirf scope likha hai.

| Part | Naam | Roadmap items |
|------|------|---------------|
| **1** | **PnL Tracker (EVM + Solana + Tron) — ✅ BUILT** | #4 |
| 2 | Swap alerts: Solana / Tron / TON | #3 |
| 3 | Smart Money / Copy-wallet alerts | #1 |
| 4 | Safe / Risky score (rug-pull, honeypot) in alerts | #2 |
| 5 | Onboarding tour, Templates, Wallet labels/notes/compare | #5, #8 |
| 6 | Security: Approval checker / Revoke + security audit | #9, #18 |
| 7 | Market tools: calendar, gas alerts, sentiment widget | #6, #7, #11 |
| 8 | Reports & sharing: Tax PDF (India 30%), Share cards | #10, #12 |
| 9 | Reliability: realtime webhooks, delivery channels, PWA, modules/tests/Sentry | #13, #14, #16, #17 |
| 10 | Growth: multi-language, leaderboard/streak, Pro trial/referral tiers, public API | #15, #19, #20, #21 |

---

# PART 1 — PnL Tracker (original plan)

## 1. Abhi code me kya hai (zip check kiya)

- `index.html` ka "Unrealized P&L" card (`drawPnl`, ~line 1854) **asli PnL nahi hai**. Wo `total value − user ka manually dala invested amount` hai.
- Asli trade-level PnL (buy/sell match, win-rate, best/worst trade) **kahin nahi hai**.
- Wallet history ke liye `lib/txhistory.js` me functions pehle se hain: `evmHistory`, `bscHistory`, `tronHistory`, `solHistory`, `tonHistory`. Ye `txHistory` route ke andar use hote hain, export nahi hain.
- `lib/portfolio.js` me `portfolio_snapshots` table se value history aati hai.
- `lib/entitle.js` ka comment pehle se "P&L window" Advanced Analytics ke saath bolta hai. Matlab gating ka rasta ready hai: `analyticsAccess(uid)` (Free = 7 din, Advanced = 30 din).
- `lib/plans.js` me wallet limits hain, aur `lib/balances.js` me `fetchPrices()` hai.

**Aham limitation:** `txhistory.js` abhi transfers dikhata hai (kisko kitna gaya). PnL ke liye **swap/trade** chahiye (kya becha, kya kharida, kis price par). Isliye pehle ek naya data layer chahiye.

## 2. Part 1 ka scope

**Included**
- Realized PnL (bik chuke trades), unrealized PnL (abhi holdings), win-rate, best trade, worst trade
- Time filter: 24h / 7d / 30d (Free = 7d, Advanced = 30d, existing `analyticsAccess` se)
- Chains: Ethereum/BSC/Polygon/Arbitrum/Base etc. (EVM), **Solana**, Tron, TON
- Per-wallet aur combined (all wallets) view
- Portfolio tab me PnL card + trades list, en/hi strings

**Not included (baad ke parts me)**
- Tax PDF aur India 30% format → Part 8
- Share card image → Part 8
- Realtime push → Part 9

## 3. Design

### 3.1 Naya module: `lib/pnl.js`

```
lib/pnl.js
  fetchTrades(network, address, sinceTs)  -> Trade[]      // chain-wise adapters
  priceAt(symbol|mint, ts)                -> usd          // historical price
  computePnl(trades, currentPrices)       -> PnlSummary   // FIFO engine
  pnlRoute(req, res)                      // GET /api/pnl
```

Route `api/index.js` me portfolio routes ke paas jodna:
`if (path === "/api/pnl") return await pnlRoute(req, res);`

### 3.2 Normalized Trade format (sab chains ke liye ek)

```js
{
  ts, network, wallet, txHash,
  side: "buy" | "sell",
  token: { symbol, address /* mint/contract */, decimals },
  amount,          // token qty
  usdValue,        // trade ke waqt ki USD value
  feeUsd
}
```

### 3.3 Chain adapters (data kahan se aayega)

| Chain | Source | Note |
|-------|--------|------|
| EVM | Etherscan V2 `tokentx` + native txs (jo `evmHistory` already use karta hai) | Token transfer ko swap tab maano jab usi tx me ek token **out** aur doosra **in** ho. Single-direction transfer ko trade na gino (wo send/receive hai). |
| Solana | **Helius** Enhanced Transactions API (`type=SWAP`) | Naya env: `HELIUS_API_KEY`. Public RPC par swap parse karna bahut dukhad hai. Isse pump.fun/Jupiter/Raydium swaps seedha parsed milte hain. Part 2 me wahi key reuse hogi. |
| Tron | TronGrid TRC20 transfers + SunSwap router calls | Env `TRONGRID_API_KEY` pehle se hai |
| TON | TONCenter jetton transfers + DEX (STON.fi / DeDust) | Pehle version me "best effort", UI par beta label |

**Chain-wise rollout order:** EVM → Solana → Tron → TON. Har chain alag PR/commit.

### 3.4 PnL engine (FIFO)

- Har token ke liye buy "lots" ki queue banao. Sell aaye to sabse purane lot se match karo.
- `realized = sellUsd − costBasisOfMatchedLots − fees`
- `unrealized = currentQty × currentPrice − remainingCostBasis`
- `winRate = profitable closed trades / total closed trades`
- Stablecoins (USDT/USDC/DAI) ko **quote currency** maano. Unka apna PnL nahi gino.
- Jo token sirf receive hua (airdrop/transfer-in, cost nahi pata) → cost basis `0` mat maano. Usse **"unknown cost"** flag karke PnL se alag rakho, warna PnL fake bada dikhega.

### 3.5 Historical price

- Majors (ETH/BNB/SOL/TRX/TON): CoinGecko history (project me `fetchPrices` CoinGecko pattern use karta hai).
- Chhote/pump.fun tokens: swap me jo quote amount (SOL/USDC) mila usse implied price nikalo. Alag price API ki zarurat nahi, aur ye zyada accurate hai.
- Price na mile to trade ko `priceMissing: true` karke skip karo. Kabhi guess na karo.

### 3.6 Caching (zaroori, warna API limits khatam)

Nayi table `pnl_cache`:

```sql
CREATE TABLE IF NOT EXISTS pnl_cache (
  user_id     BIGINT NOT NULL,
  network     TEXT   NOT NULL,
  address     TEXT   NOT NULL,
  trades      JSONB  NOT NULL,
  last_ts     BIGINT NOT NULL,       -- yahan tak ke trades fetch ho chuke
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, network, address)
);
```

- Pehli baar: poori window fetch. Uske baad sirf `last_ts` ke baad ke naye trades.
- Response cache TTL: 5 min.

### 3.7 API contract

`GET /api/pnl?days=7|30&wallet=<optional network:address>`

```json
{
  "ok": true,
  "locked": false,
  "days": 30,
  "summary": {
    "realizedUsd": 0, "unrealizedUsd": 0, "totalUsd": 0,
    "winRate": 0, "closedTrades": 0,
    "best":  { "token": "", "pnlUsd": 0, "txHash": "" },
    "worst": { "token": "", "pnlUsd": 0, "txHash": "" }
  },
  "byToken": [{ "token": "", "realizedUsd": 0, "unrealizedUsd": 0, "unknownCost": false }],
  "trades": [],
  "warnings": ["TON: beta", "3 tokens ka cost unknown"]
}
```

Errors project ke style me: `UNAUTHENTICATED` (401), `RATE_LIMITED` (429), `PNL_FAILED` (500).

### 3.8 Security / limits

- `readSession(req)` se auth. Wallet list user ke apne saved wallets se hi lo, body se arbitrary address mat lo.
- Rate limit: existing `lib/ratelimit.js` use karo (`rateLimited`). Per user 10 req/min.
- Free user ko `days` clamp: `analyticsAccess` false ho to max 7.
- Helius key sirf server env me. Frontend ko kabhi mat bhejo.

### 3.9 UI (Portfolio tab)

- Purane "Unrealized P&L (invested amount)" card ko **rakho**, uske neeche naya **"Trading PnL"** section jodo. Purana feature todna nahi hai.
- 4 stat cards: Realized, Unrealized, Win-rate, Trades.
- Best / Worst trade row.
- Token-wise table (sort by PnL).
- Filter chips: 24h / 7d / 30d. Free user ke liye 30d par lock icon.
- Loading skeleton. "Unknown cost" wale tokens ke paas info icon.
- Strings `en` + `hi` dono me (existing i18n pattern follow karo).

## 4. Kaam ki list (isi order me)

1. `lib/pnl.js` skeleton + normalized Trade type
2. FIFO engine + unit tests (`scripts/test-pnl.mjs`, existing `scripts/test-*.mjs` jaise)
3. EVM adapter
4. `/api/pnl` route + `pnl_cache` table + entitlement/rate-limit
5. Portfolio tab UI
6. Solana adapter (Helius)
7. Tron adapter
8. TON adapter (beta)
9. en/hi strings, final QA

## 5. Test cases (engine ke liye zaroori)

- 1 buy, 1 sell, profit → win
- 1 buy, partial sell → remaining lot sahi bacha
- 2 buys alag price, 1 sell dono lots cross kare (FIFO check)
- Sirf receive hua token (unknown cost) → PnL me nahi judna chahiye
- Fee ke saath trade
- Price missing → trade skip + warning
- Stablecoin ↔ stablecoin → ignore
- Empty wallet → zero summary, error nahi

## 6. Env variables (nayi)

```
HELIUS_API_KEY=        # Solana swaps (Part 1 aur Part 2 dono me kaam aayegi)
ETHERSCAN_API_KEY=     # pehle se zaroori
TRONGRID_API_KEY=      # pehle se hai
```

## 7. Risks

| Risk | Kya karenge |
|------|-------------|
| Vercel function timeout (lambdi history) | Cache + incremental fetch, aur max 200 trades per wallet per request |
| Etherscan/Helius rate limit | `pnl_cache` + 5 min response cache |
| Complex DeFi txs (LP, bridge) galat swap lag sakte hain | v1 me sirf clear swaps ginenge. Baaki ko "other" me daalo, PnL se bahar |
| Cost basis unknown | Alag flag, PnL me fake zero cost nahi |

## 8. Part 1 "Done" kab maana jaye

- EVM + Solana wallet par realized/unrealized/win-rate/best/worst sahi aaye (known test wallet se manually verify)
- Free user 7d tak, Advanced 30d tak
- Tests pass, `/api/pnl` rate-limited
- Hindi + English UI

---

# PART 1 — Build status (jo actually bana)

## Files

| File | Kaam |
|------|------|
| `lib/pnl_engine.js` (new) | Pure engine: FIFO PnL + EVM / Solana(Helius) / Tron parsers. DB ya network nahi, isliye offline testable |
| `lib/pnl.js` (new) | `GET /api/pnl` route: fetchers, `pnl_cache` table (auto-create), entitlement, rate-limit |
| `scripts/test-pnl.mjs` (new) | 21 unit tests. Chalane ke liye: `npm run test:pnl` |
| `api/index.js` | `/api/pnl` route wire kiya (2 lines) |
| `index.html` | Portfolio tab me naya **Trading PnL** card: 24H/7D/30D chips, Realized/Unrealized/Win-rate/Best-Worst, token table, trades list |
| `package.json`, `README.md` | `test:pnl` script, env note |

## Kya kaam karta hai

- **EVM** (Ethereum, Polygon, Arbitrum, Base, Optimism, Avalanche): Etherscan V2 se swaps. Token ↔ stablecoin/native swap hi trade ginta hai.
- **Solana**: Helius `type=SWAP`. SOL/USDC/USDT ↔ pump.fun type tokens.
- **Tron**: sirf token ↔ USDT/USDC swaps.
- Realized, unrealized, win-rate, best/worst trade, token-wise PnL, recent trades.
- Free = 7 din max, Advanced Analytics (paid/points boost) = 30 din. Server khud clamp karta hai.
- Wallets sirf user ki saved watchlist se aate hain (request se nahi). Max 5 wallets per request, 10 req/min per user.
- Trades `pnl_cache` me merge hote hain, to history ek API page se zyada badhti jaati hai. 5 min response cache.

## Safety rules (jaan-boojh kar)

- Stablecoin **contract address** se pehchana jata hai, symbol se nahi. "USDT" naam ka scam token $1 nahi maana jata.
- Sirf clean 1-out / 1-in swaps. Wrap/unwrap (ETH ↔ WETH), plain transfer, LP, bridge, token ↔ token **trade nahi** gine jaate.
- Historical price na mile to trade skip + warning. Kabhi guess nahi.
- Sell ke saath buy nazar na aaye to "cost unknown" flag, realized PnL me **nahi** judta (fake profit nahi).
- Token ka unrealized PnL last-trade price se hota hai (UI par `~` aur warning). Native coin ka live price.

## Kya TEST hua aur kya NAHI

- ✅ Engine + parsers: 21 unit tests pass.
- ✅ Route: stubbed DB + mock APIs ke saath smoke test pass (Solana PnL ≈ $150, cache hit, free-plan 7-day clamp, TON warning, auth).
- ✅ `index.html` ke saare inline scripts ka syntax check pass.
- ❌ **Live APIs ke saath test nahi hua** (yaha network nahi tha). Etherscan/Helius/TronGrid ke asli response shape par pehli baar verify karna hoga: known wallet se 1 baar check karo.
- ❌ UI browser me render karke nahi dekha.

## Abhi NAHI bana (honest list)

- **TON PnL**: abhi supported nahi. API `warnings` me "TON: PnL is not supported yet" dikhata hai. (Plan me "beta" tha, lekin bina verify kiye DEX parse karna galat PnL deta.)
- **BSC**: Etherscan free plan BSC cover nahi karta. Key/plan cover kare to chalega, warna warning aayegi. NodeReal adapter Part 9 me.
- **Hindi strings**: current UI me i18n system hi nahi hai (poora app English), isliye PnL card English me hai.
- Per wallet ek page (100 rows per call) fetch hota hai; purani history cache me jama hoti jaati hai.
- Token ke symbol Solana par short mint (`Pump…pump`) dikhte hain, kyunki Helius swap events me symbol nahi aata.

## Deploy checklist

1. Vercel env: `ETHERSCAN_API_KEY` (pehle se), **`HELIUS_API_KEY` (naya)**, `TRONGRID_API_KEY` (optional).
2. Deploy. `pnl_cache` table pehli request par apne aap bann jaati hai.
3. Ek known wallet add karke Portfolio → Trading PnL → ↻ dabao, aur explorer se 1–2 trade manually match karo.
4. `npm run test:pnl`

---

# Parts 2–10 (sirf scope, detail baad me)

- **Part 2** — Helius (Solana), TronGrid, TONCenter se swap events. Contract BUY/SELL monitor ko EVM se aage badhana. `lib/newcoins.js` aur `lib/community_contracts.js` ke saath integrate.
- **Part 3** — Famous wallets ki list + follow button, un wallets ke buy/sell par alert. Part 1 ka trade adapter reuse hoga.
- **Part 4** — `lib/scanner.js` ko alerts me jodna. Score: Safe / Risky / Danger, reasons ke saath.
- **Part 5** — 3-step onboarding (wallet add → alert set → channel join), wallet naam/tag/notes, wallet compare. `lib/templates.js` extend.
- **Part 6** — Unlimited approvals list + revoke link. Saath me admin routes, rate-limit coverage, secrets ka audit.
- **Part 7** — Token unlock/airdrop calendar, gas threshold alert, Fear & Greed / BTC dominance / funding / liquidations widget.
- **Part 8** — Tax report PDF (India 30% + 1% TDS format) via `lib/export.js`, aur PnL/portfolio share card image.
- **Part 9** — Webhooks (Alchemy/Helius) se realtime, email/Discord/webhook delivery, PWA + skeleton loaders, `api/index.js` aur `index.html` ko modules me todna, tests, Sentry.
- **Part 10** — Bengali/Tamil/Telugu/Spanish/Russian/Turkish, leaderboard + streak (`points`), 3-day Pro trial + referral tiers (`lib/referral.js`), public API / white-label.
