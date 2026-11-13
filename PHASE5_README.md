# Phase 5/6 — MBC Points (drop-in over blockchain-tracker-miniapp v0.4/0.5)

Copy these files over the repo (same paths). Changed existing files: `api/index.js`, `index.html`, `lib/plans.js`, `lib/maintenance.js`, `lib/payments.js`, `lib/onchain_alerts.js`. New: `db/points.sql`, `lib/points.js`, `lib/points_api.js`, `assets/points-ui.js`, `scripts/test-points.mjs`.

## Deploy
1. Neon: run `db/points.sql` (additive, re-runnable) — after `db/community_phase3b.sql`.
2. Env (optional): `POINTS_AD_SECRET` (enables rewarded-ad callback; without it ads are off). `ADMIN_TELEGRAM_IDS` already used.
3. Deploy. `npm install && node scripts/test-points.mjs`.
4. Order matters: run the SQL BEFORE deploying — plans.js reads boosts (it tolerates missing tables and falls back to plan limits).

## What each patch does
- plans.js: `limitsFor` adds active boosts (wallets, contracts, notifications/day, alerts). Every existing limit check already goes through it.
- maintenance.js: hourly expiry job, 30-day warning, stale-reservation release (runs inside the existing 5-min worker).
- onchain_alerts.js: first valid wallet/contract alert awards points (best-effort; never blocks the alert). Also qualifies the referrer.
- api/index.js: mounts `/api/points/*`; `POST /api/subscription/create-payment` accepts optional `redemptionId` (server reserved discount).
- payments.js: `confirmForPayment` inside the existing confirmation transaction (reserved -> spent atomically with plan activation).

## Checkout flow
quote (`/discount/quote {planCode}`) -> reserve (`/discount/reserve {planCode, points}`) -> create-payment `{planCode, chain, redemptionId}` -> user pays -> points deducted automatically on confirmation. `/discount/confirm` is a read-only status check (deduction is never client-triggered). `/discount/release` cancels an unpaid reservation.

## Decisions you must confirm (defaults chosen)
1. **$1 Pro plan cannot use tiers**: 20% of $1 = $0.20 < smallest tier $0.50. Options: set `discount.flex=true` (multiples of 100 points, up to 200 pts on Pro) or accept that discounts start at the $2.50 plan.
2. Referral (50) and one-time wallet/contract (10) rewards are OUTSIDE the 100/day cap; login, ads, daily task are inside. Change via admin settings `rewards.<code>.capped`.
3. Inactivity reset = successful claim, earn or redeem only (not login, not background).
4. Daily task = "Sync balances in Portfolio today" (server-verified via portfolio_snapshots). Replace with your own verifiers if wanted.
5. Referral qualifies when the invited user adds their first valid wallet/contract (existing `referred_by` link), max 10/day per referrer.
6. Ads: provider-neutral HMAC callback `POST /api/points/ad-callback {telegramId,eventId,ts,sig}`; sig = HMAC-SHA256(POINTS_AD_SECRET, `${telegramId}.${eventId}.${ts}`) hex. Needs your ad provider to call it.
7. Paid discount edge: if a reservation is released while a late payment still confirms, points are deducted if available, otherwise an audit row `points.discount_shortfall` is written (balance never goes negative).

## Not done / not verified
- SQL was NOT run against a live Postgres (none available here). Run the checklist below on a Neon branch first.
- Not wired: Token Scanner credit consumption (`consumeScannerCredit`) and advanced-analytics gating (`hasAdvancedAnalytics`) — call them where those features live.
- Subscription page UI for choosing points at checkout is not built (API ready); Profile card shows balance, tasks, boosts, history.
- Admin Panel screens not built (admin API ready: `/api/points/admin/settings|user|adjust|reverse|reconcile`).

## Live-DB smoke checklist
1. Claim `daily_login` twice -> 2nd = ALREADY_CLAIMED. 2. Fire 20 parallel claims/redeems -> balance never negative, daily earned <= 100. 3. Reserve 500 pts, create payment with redemptionId, confirm -> ledger redeem row, balance down, reserved 0. 4. Let a reservation expire -> hourly job frees it. 5. Set last_qualifying_activity_at to 366 days ago -> run maintenance -> expire row + expiry log. 6. `/admin/reconcile` returns no mismatches.
