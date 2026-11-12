# Blockchain Tracker — Telegram Mini App (v0.4.0)

Single Vercel function: **`api/index.js`** dispatches every route; helpers live in `/lib`. Frontend is `index.html`.

## Launch plans and limits (updated 2026-11-12)

| Plan | Price / 30 days | Wallets | Contracts | Wallet transaction notifications/day | Contract transaction notifications/day | Price alerts/day |
|---|---:|---:|---:|---:|---:|---:|
| Free | Free lifetime | 10 | 10 | 500 | 500 | 50 |
| Pro | 1 USDT | 25 | 25 | 1,500 | 1,500 | 150 |
| Business | 2.5 USDT | 50 | 50 | 5,000 | 5,000 | 500 |
| Enterprise | 5 USDT | 100 | 100 | 10,000 | 10,000 | 1,000 |

Transaction notification quotas are enforced separately for wallet and contract events. Price-alert delivery has its own daily cap. Active alert rules are also capped by the plan's alert allowance. Run `db/launch_limits_migration.sql` on an existing Neon database before deploying this update; new databases can use the normal setup SQL files below.

## API routes
**Auth/account:** `POST /api/auth/telegram`, `GET /api/auth/me`, `GET /api/subscription/plans|me`, `POST /api/subscription/create-payment|verify-payment` (real on-chain USDT verification: BEP20 via BSC RPC, TRC20 via TronGrid).
**Alerts:** `/api/alerts` (price), `/api/alerts/onchain` (wallet · whale · **contract**), cron: `/api/cron/alerts`, `/api/cron/onchain`.
**Data:** `/api/portfolio/balances|history`, `/api/market/overview|whales` (whales now carry exchange labels on Ethereum), `/api/network/status`.
**New in 0.3.0**
- `GET|PUT /api/watchlist` — cloud-synced watchlist + invested amount (plan-limited).
- `GET /api/defi/overview` — TVL by chain + top DEX volume (DeFiLlama).
- `GET /api/tx/history?q=<hash|address>&network=&type=` — tx lookup (RPC/TronGrid/Solana) and wallet history (Etherscan V2 for EVM, TronGrid, Solana RPC, TONCenter).
- `/api/admin/stats|payments|users|user|grant` — server-side admin (Telegram IDs in `ADMIN_TELEGRAM_IDS`), audit-logged.
- `POST /api/telegram/webhook` — bot commands `/start /help /price /alerts`.
- Rate limiting on login, payments, watchlist, tx history, admin. Plan limits unified in `lib/plans.js` (price + on-chain alerts now share one limit).
- Contract monitor: ownership transfer, proxy upgrade/admin change, pause/unpause, role grant/revoke on EVM contracts.

## New in 0.4.0 — Telegram channels & scheduled auto-alerts (Admin Panel)
Admin Panel → **Telegram Channels & Auto Alerts**. Unlimited channels, each tied to one blockchain (or "All"), each with any number of alerts.
- **Channel**: add / edit / delete, master **ON/OFF**, **Test** message, **Send message** (manual post). The bot must be an admin of the channel; it is verified with Telegram when you save.
- **Alert types**: 📈 price (list every time, or only when price moves ≥ X%), 🆕 new token (DexScreener, age + min liquidity filter), 💧 liquidity (drop / rise / below-limit), 🐋 whale transfers (Ethereum, BNB Chain, Polygon), 🚀 gainers & losers, 🔥 trending coins.
- **Scheduler per alert**: repeat every 5 min … 7 days, or once a day at a fixed time (IST by default, any time zone). Each alert has its own **ON/OFF**, **Edit**, **Send now**, **Delete**.
- **API** (admin only): `GET /api/admin/channels`, `POST /api/admin/channel-save|channel-toggle|channel-delete|channel-test|channel-send|rule-save|rule-toggle|rule-delete|rule-run`, `GET /api/admin/coin-search?q=`. Worker: `GET /api/cron/channels` (added to `.github/workflows/cron.yml`).
- **Setup**: run `db/channels.sql` in Neon (after the older SQL files), redeploy. Needs `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `ADMIN_TELEGRAM_IDS` (already used by the app).
- Timing: the worker runs when the cron calls it (GitHub Actions: every 5 min, can be delayed a few minutes). For tighter timing call `/api/cron/channels` from cron-job.org with the header `Authorization: Bearer <CRON_SECRET>`.
- Telegram limit: about 20 messages per minute per group, so avoid many 5-minute alerts on one channel.

## DEX Screener (trending, new coins, buy/sell, charts)
Frontend page **DEX Screener** (sidebar + dashboard quick action). Backend: `lib/dex.js`, routed from `api/index.js` (public GET, 90 req/min per IP, cached 10–60 s; no API key).
- `GET /api/dex/trending?source=top|latest` — most boosted / latest boosted coins with price, liquidity, volume, buys/sells.
- `GET /api/dex/new?source=profiles|updates|boosts` — new coins (tokens with a new profile/boost), newest pair first.
- `GET /api/dex/buysell?tf=m5|h1|h6|h24&sort=buyPct|buys|sells|volume` — buy/sell pressure ranking.
- `GET /api/dex/search?q=` · `GET /api/dex/pair?chain=&pair=` · `GET /api/dex/token?chain=&address=` (all pools of a token).
- `GET /api/dex/metas` · `GET /api/dex/meta?slug=` — trending narratives and their coins.
- Charts and the live trade list use DexScreener's own embed (`?embed=1`). The public API has no candle history and no trade-by-trade feed, only buy/sell counts per 5m/1h/6h/24h.

## Setup
1. Run in Neon (in order): `db/schema.sql`, `db/price_alerts.sql`, `db/portfolio.sql`, `db/onchain_alerts.sql`, `db/phase5.sql`, **`db/channels.sql`**, then `db/launch_limits_migration.sql` for an existing database.
2. Set env vars — see `.env.example`.
3. Deploy to Vercel.
4. Schedulers: add repo secrets `APP_URL` + `CRON_SECRET` and the workflow `.github/workflows/cron.yml` runs both workers every 5 min (Vercel Hobby only allows daily crons).
5. Bot webhook (once):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

## Status
Backend and frontend wiring (watchlist sync, admin panel, Telegram channels & auto alerts, DeFi cards, tx search, contract monitor, exchange labels, bot) are done.
`.env.example` and `scripts/set-webhook.mjs` are included: run `npm run webhook` once after deploy (and `npm run webhook:info` to check).
`.github/workflows/cron.yml` now runs price, on-chain and **channel** workers every 5 min.
Exchange labels are a small seed list — verify/extend via `EXCHANGE_LABELS_JSON`.

## Launchpad (pump.fun-style, Meteora Dynamic Bonding Curve)
Page: `launch.html` (Explore · Create coin · Buy/Sell). Backend: `lib/launchpad.js` -> `/api/launch/*`. Non-custodial: server builds unsigned transactions, the user's Phantom wallet signs.
1. `npm install`, then run `db/launchpad.sql` in Neon.
2. Create your bonding-curve config once, on your own computer, **on devnet first**: `KEYPAIR_PATH=./owner.json THRESHOLD_SOL=2 SOLANA_RPC_URL=https://api.devnet.solana.com npm run launch:config`
3. Vercel env: `DBC_CONFIG_KEY` (printed above), `SOLANA_RPC_URL` (a private RPC, e.g. Helius/QuickNode), `APP_URL`, optional `LAUNCH_NETWORK`, `LAUNCH_DAILY_LIMIT`.
4. Wallet signing needs Phantom: inside Telegram's built-in browser use the "Open in Phantom" button on the page.
