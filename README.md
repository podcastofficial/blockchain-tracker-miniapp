# Blockchain Tracker — Backend Phase 2 (Single API)

This version uses exactly **one Vercel API function file**: `api/index.js`.
All endpoints are dispatched inside that file. Shared helper modules are stored in `/lib`, outside `/api`, so they do not create additional Vercel Function routes.

## Routes handled by the single function
- `POST /api/auth/telegram`
- `GET /api/auth/me`
- `GET /api/subscription/plans`
- `POST /api/subscription/create-payment`
- `POST /api/subscription/verify-payment`

`vercel.json` rewrites all `/api/...` requests to the single `/api` function.

## Subscription baseline
- Free: 0 USDT, lifetime
- Pro: 1 USDT / 30 days
- Business: 5 USDT / 30 days
- Enterprise: custom (not purchasable in this initial API)
- Payment network choices: BEP20 and TRC20 USDT

## Setup
1. Merge `api/`, `lib/`, `db/`, `package.json`, `.env.example`, and `vercel.json` into the existing repo root. Keep the existing frontend `index.html`.
2. In Neon, run `db/schema.sql`.
3. Run `npm install`, then commit `package-lock.json`.
4. Add environment variables from `.env.example` to Vercel.
5. Set the Telegram bot token, session secret (32+ random bytes), database URL, and verified receiving addresses.

## Test endpoints
- `GET /api/subscription/plans`
- From Telegram Mini App, `POST /api/auth/telegram` with JSON `{ "initData": "<Telegram.WebApp.initData>" }`.
- `GET /api/auth/me` with the session cookie.
- `POST /api/subscription/create-payment` with `{ "planCode": "pro", "chain": "BEP20" }`.

## Safety / production status
- `api/index.js` is the only API file in this package.
- Payment verification deliberately does **not** activate subscriptions yet. A chain-specific BEP20/TRC20 verifier must independently confirm the exact USDT contract, destination, amount, transaction success, replay protection, and confirmation depth before production payments are accepted.
- Do not trust screenshots or client-provided payment status.
- Do not put database credentials, bot token, RPC keys, or session secret in frontend code.
- Admin authorization, rate limiting, wallet APIs, alert workers, payment reconciliation and frontend integration are not included yet.
