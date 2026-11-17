# Wallet — Part 1/5: DB + wallet core + addresses + ledger

Is zip me SIRF changed/new files hain. Apne project me same paths par copy-paste (overwrite) kar do.

## Files
- NEW  lib/hdwallet.js        – seed se har user ke liye unique address (EVM / TRON / SOLANA), koi extra npm package nahi
- NEW  lib/wallet.js          – wallet create, addresses, assets, balances, ledger (atomic + idempotent) + API
- NEW  lib/wallet_schema.js   – db/wallet.sql ka auto copy (API pehli call par tables khud bana deti hai)
- NEW  db/wallet.sql          – tables: wallet_assets, wallets, wallet_addresses, user_balances, ledger_entries, deposits, withdrawals, chain_cursors
- NEW  scripts/test-wallet.mjs
- EDIT api/index.js           – 1 import + 1 route line (/api/wallet/*)
- EDIT package.json           – script "test:wallet"

## Setup (zaroori)
Vercel env me add karo: `WALLET_MASTER_SEED` = 12/24 word phrase ya 64-char hex.
- Isko SIRF server env me rakho, backup alag jagah (isi seed se saare user addresses ke funds nikalte hain).
- Baad me badloge to API `WALLET_SEED_MISMATCH` deke ruk jayegi (purane addresses kho na jayein).
- Optional: db/wallet.sql Neon/Supabase me manually bhi run kar sakte ho.

## API (login required)
GET /api/wallet · POST /api/wallet/create · GET /api/wallet/addresses · /assets · /balances · /ledger?limit=&before=&asset=

## Ek address kaha-kaha chalta hai
EVM address = ETH, BSC, Polygon, Arbitrum, Base, Optimism, Avalanche (same 0x). TRON = TRX + USDT-TRC20. Solana = SOL + USDT/USDC.

## Test
`npm run test:wallet` (10 tests, DB/network nahi chahiye)

## Aage
Part 2 deposit auto-detect · Part 3 withdraw request · Part 4 Binance-style Assets page · Part 5 wallet-connect hatana (launch/swap/index) + final polish
