# Blockchain Tracker — Backend + Frontend Integration

## Single Vercel API architecture
Exactly one Vercel function entry file is used: `api/index.js`. All routes are dispatched from this file. Shared helper modules live in `/lib`.

## Live API routes
- `POST /api/auth/telegram` — verifies Telegram Mini App initData and creates an HttpOnly session cookie.
- `GET /api/auth/me` — returns the authenticated Telegram account.
- `GET /api/subscription/plans` — returns plans from Neon PostgreSQL.
- `GET /api/subscription/me` — returns current active subscription or Free fallback.
- `POST /api/subscription/create-payment` — creates a pending payment record.
- `POST /api/subscription/verify-payment` — intentionally fails closed until an independent on-chain verifier is implemented.

## Pricing baseline
- Free: 0 USDT, lifetime
- Pro: 1 USDT / 30 days
- Business: 5 USDT / 30 days
- Enterprise: custom

## Frontend integration
- The Subscription & API page loads plans from `/api/subscription/plans`.
- Inside Telegram, the app sends `Telegram.WebApp.initData` to `/api/auth/telegram`.
- The HttpOnly session cookie is used for `/api/auth/me` and `/api/subscription/me`.
- Paid checkout buttons remain disabled while on-chain verification is not implemented. This prevents users sending funds into an unfinished payment flow.
- The existing local watchlist and other frontend modules are preserved.

## Setup / deploy
1. Merge this folder into the existing repository, keeping the `index.html`, `api/`, `lib/`, `db/`, `package.json`, and `vercel.json` at repository root.
2. Ensure `db/schema.sql` has already been executed in Neon.
3. Confirm Vercel environment variables are set: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `APP_SESSION_SECRET`, and receiving wallet addresses.
4. Deploy to Vercel.
5. Test:
   - `https://YOUR_DOMAIN/api/subscription/plans`
   - Open the app inside Telegram and visit Subscription & API.
   - Confirm Telegram login status and Free subscription are displayed.

## Payment safety status
The app does not yet accept payments. The verify endpoint deliberately does not activate subscriptions. Production verification must validate the official USDT token contract for the selected chain, recipient, exact amount, successful transaction receipt, confirmation depth, unique transaction use, and payment ownership before activation. Do not accept screenshots or client-provided status as proof.

## Security notes
- Never expose database URL, Telegram bot token, session secret, or RPC credentials in frontend JavaScript.
- Keep only one file under `/api`: `api/index.js`.
- This phase does not yet include admin authorization, rate limiting, on-chain verification, alert workers, or full wallet tracking APIs.
