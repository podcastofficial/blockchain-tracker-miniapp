# Wallet exchange implementation notes

## Included in this update

- Existing per-user HD wallet core retained (`lib/hdwallet.js`, `lib/wallet.js`).
- Added authenticated withdrawal request/history endpoints.
- Withdrawal requests reserve amount + configured asset withdrawal fee in the user's available balance.
- Added admin-only withdrawal queue with approve, reject, fail/release, and record-broadcast-transaction actions.
- Added BEP20 USDT and TRC20 USDT deposit scanner for the per-user derived addresses.
- Deposits are credited only after the configured confirmation threshold / Tron solidity finality and use idempotent deposit + ledger inserts.
- Added `/api/cron/wallet-deposits`; GitHub Actions cron now calls it every five minutes.
- Added Binance-inspired Assets page with balances, deposit addresses, deposit/withdrawal history and ledger.
- Added an initial Spot Trading page placeholder. It intentionally does not accept orders until the internal matching engine is implemented and tested.

## Required server configuration

- `DATABASE_URL`
- `APP_SESSION_SECRET` (existing auth requirement)
- `WALLET_MASTER_SEED` (12/15/18/21/24-word BIP39 phrase or 32-64-byte hex seed; keep server-side only and back it up securely)
- `ADMIN_TELEGRAM_IDS`
- `CRON_SECRET`
- Optional `RPC_BSC`, `TRONGRID_API_KEY`

## Important custody / operational notes

- The per-user deposit addresses are derived from `WALLET_MASTER_SEED`; changing the seed after issuing addresses makes those funds inaccessible through this wallet derivation. Do not rotate it without a migration plan.
- The subscription invoice receivers remain separate from these per-user wallet addresses. The new scanner does not credit subscription invoices into trading balances.
- The withdrawal approval flow does not broadcast transactions automatically. Admin must send the transfer from the secure wallet operations environment, then record its transaction hash in the admin panel. This avoids pretending a transfer was sent when no signer/broadcaster has run.
- Before accepting real funds, test with small amounts on both networks, verify RPC/provider limits, backups, signer isolation, gas funding, monitoring, and recovery procedures.
- Spot order matching, market listings and DEX/launchpad buy/sell rewiring are not enabled in this update. The Spot Trading page remains deliberately disabled until that engine is implemented.
