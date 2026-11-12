# Blockchain Tracker — Telegram Mini App (v0.4.0)

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

## New in 0.4.0 — Telegram channels & scheduled auto-alerts (Admin Panel)
Admin Panel → **Telegram Channels & Auto Alerts**. Unlimited channels, each tied to one blockchain (or "All"), each with any number of alerts.
- **Channel**: add / edit / delete, master **ON/OFF**, **Test** message, **Send message** (manual post). The bot must be an admin of the channel; it is verified with Telegram when you save.
- **Alert types**: 📈 price (list every time, or only when price moves ≥ X%), 🆕 new token (DexScreener, age + min liquidity filter), 💧 liquidity (drop / rise / below-limit), 🐋 whale transfers (Ethereum, BNB Chain, Polygon), 🚀 gainers & losers, 🔥 trending coins.
- **Scheduler per alert**: repeat every 5 min … 7 days, or once a day at a fixed time (IST by default, any time zone). Each alert has its own **ON/OFF**, **Edit**, **Send now**, **Delete**.
- **API** (admin only): `GET /api/admin/channels`, `POST /api/admin/channel-save|channel-toggle|channel-delete|channel-test|channel-send|rule-save|rule-toggle|rule-delete|rule-run`, `GET /api/admin/coin-search?q=`. Worker: `GET /api/cron/channels` (added to `.github/workflows/cron.yml`).
- **Setup**: run `db/channels.sql` in Neon (after the older SQL files), redeploy. Needs `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `ADMIN_TELEGRAM_IDS` (already used by the app).
- Timing: the worker runs when the cron calls it (GitHub Actions: every 5 min, can be delayed a few minutes). For tighter timing call `/api/cron/channels` from cron-job.org with the header `Authorization: Bearer <CRON_SECRET>`.
- Telegram limit: about 20 messages per minute per group, so avoid many 5-minute alerts on one channel.

## Setup
1. Run in Neon (in order): `db/schema.sql`, `db/price_alerts.sql`, `db/portfolio.sql`, `db/onchain_alerts.sql`, `db/phase5.sql`, **`db/channels.sql`**.
2. Set env vars — see `.env.example`.
3. Deploy to Vercel.
4. Schedulers: add repo secrets `APP_URL` + `CRON_SECRET` and the workflow `.github/workflows/cron.yml` runs both workers every 5 min (Vercel Hobby only allows daily crons).
5. Bot webhook (once):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

## Status
Backend for watchlist sync, admin, DeFi, tx explorer, contract monitor, exchange labels and bot is done.
**Frontend wiring for these pages is the next step** (admin UI, DeFi cards, tx search, watchlist sync, stale labels, P&L card).
Exchange labels are a small seed list — verify/extend via `EXCHANGE_LABELS_JSON`.
