-- Phase 5/6: MBC Points (ledger, tasks, boosts, discount reservations). Additive, safe to re-run.
-- Run once in Neon after db/community_phase3b.sql. Does not alter existing tables.
BEGIN;

-- Runtime configuration overrides (rewards, cap, expiry, catalog). Missing keys fall back to lib/points.js defaults.
CREATE TABLE IF NOT EXISTS points_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One balance row per user. balance = spendable + reserved. Never negative, reserved never above balance.
CREATE TABLE IF NOT EXISTS user_points (
  user_id                    BIGINT PRIMARY KEY REFERENCES users(id),
  balance                    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved                   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  total_earned               BIGINT  NOT NULL DEFAULT 0,
  total_redeemed             BIGINT  NOT NULL DEFAULT 0,
  total_expired              BIGINT  NOT NULL DEFAULT 0,
  last_qualifying_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expiry_warned_at           TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_points_reserved_le_balance CHECK (reserved <= balance)
);
CREATE INDEX IF NOT EXISTS idx_user_points_activity ON user_points(last_qualifying_activity_at) WHERE balance > 0;

-- Append-only ledger. Corrections are new compensating rows, never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS points_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('earn','redeem','expire','reverse','admin_adjust')),
  amount          INTEGER NOT NULL CHECK (amount <> 0),          -- signed
  balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
  reason          TEXT NOT NULL,                                  -- reward code / reward code / 'inactivity' / admin reason
  counts_to_cap   BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL,
  ref_type        TEXT,
  ref_id          TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT points_ledger_sign CHECK ((kind = 'earn' AND amount > 0) OR (kind IN ('redeem','expire') AND amount < 0) OR kind IN ('reverse','admin_adjust'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_ledger_idem ON points_ledger(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_points_ledger_cap ON points_ledger(user_id, created_at) WHERE kind = 'earn' AND counts_to_cap;

-- Verified task claims (one per user, task, UTC day; one-time tasks use day = '1970-01-01').
CREATE TABLE IF NOT EXISTS points_task_claims (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  task_code  TEXT NOT NULL,
  claim_day  DATE NOT NULL,
  points     INTEGER NOT NULL,
  ledger_id  BIGINT REFERENCES points_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, task_code, claim_day)
);

-- Provider-verified rewarded-ad completions (idempotent on the provider's event id).
CREATE TABLE IF NOT EXISTS points_ad_events (
  event_id   TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  points     INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Redemptions: feature boosts (confirmed immediately) and package discounts (reserved -> confirmed | released | expired).
CREATE TABLE IF NOT EXISTS points_redemptions (
  id              UUID PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('boost','discount')),
  reward_code     TEXT,
  points          INTEGER NOT NULL CHECK (points > 0),
  status          TEXT NOT NULL CHECK (status IN ('reserved','confirmed','released','expired')),
  plan_code       TEXT,
  original_price  NUMERIC(18,6),
  discount_usd    NUMERIC(18,6),
  final_price     NUMERIC(18,6),
  payment_id      UUID,
  idempotency_key TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_redemptions_idem ON points_redemptions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_redemptions_payment ON points_redemptions(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_points_redemptions_open ON points_redemptions(status, expires_at) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_points_redemptions_user ON points_redemptions(user_id, created_at DESC);

-- Temporary additive entitlements. resource: wallets|contracts|walletNotifications|contractNotifications|alerts|scanner_credits|advanced_analytics
CREATE TABLE IF NOT EXISTS points_boosts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  redemption_id UUID REFERENCES points_redemptions(id),
  resource      TEXT NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
  remaining     INTEGER,                                          -- only for consumable resources (scanner_credits)
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_points_boosts_active ON points_boosts(user_id, expires_at);

-- Referral qualification (referrer comes from users.referred_by, which already exists).
CREATE TABLE IF NOT EXISTS points_referrals (
  referred_id  BIGINT PRIMARY KEY REFERENCES users(id),
  referrer_id  BIGINT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL CHECK (status IN ('qualified','rejected')),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (referred_id <> referrer_id)
);
CREATE INDEX IF NOT EXISTS idx_points_referrals_referrer ON points_referrals(referrer_id, created_at DESC);

-- Daily expiry job output (one row per expired balance).
CREATE TABLE IF NOT EXISTS points_expiry_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  points     INTEGER NOT NULL,
  ledger_id  BIGINT REFERENCES points_ledger(id),
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

-- One-time onboarding rewards can only be earned once per address across ALL accounts (anti-farming).
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_onboarding_ref ON points_ledger(reason, ref_id)
  WHERE reason IN ('first_wallet','first_contract') AND kind = 'earn';
COMMIT;
