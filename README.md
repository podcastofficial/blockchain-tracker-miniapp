# Blockchain Tracker — Telegram Mini App (v0.3.0)

Single Vercel function: **`api/index.js`** dispatches every route; helpers live in `/lib`. Frontend is `index.html`.

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

## Setup
1. Run in Neon (in order): `db/schema.sql`, `db/price_alerts.sql`, `db/portfolio.sql`, `db/onchain_alerts.sql`, **`db/phase5.sql`**.
2. Set env vars — see `.env.example`.
3. Deploy to Vercel.
4. Schedulers: add repo secrets `APP_URL` + `CRON_SECRET` and the workflow `.github/workflows/cron.yml` runs both workers every 5 min (Vercel Hobby only allows daily crons).
5. Bot webhook (once):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

## Status
Backend for watchlist sync, admin, DeFi, tx explorer, contract monitor, exchange labels and bot is done.
**Frontend wiring for these pages is the next step** (admin UI, DeFi cards, tx search, watchlist sync, stale labels, P&L card).
Exchange labels are a small seed list — verify/extend via `EXCHANGE_LABELS_JSON`.
