-- v0.5.0: profile, browser login codes, referrals, expiry reminders, broadcasts.
-- Run once in Neon (after db/channels.sql). Safe to re-run.
BEGIN;

-- 1) Profile + preferences (one row per user, created on first save)
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  display_name TEXT,
  email TEXT,
  mobile TEXT,
  wallet_network TEXT,
  wallet_address TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','hi')),
  notify_price BOOLEAN NOT NULL DEFAULT TRUE,
  notify_onchain BOOLEAN NOT NULL DEFAULT TRUE,
  notify_expiry BOOLEAN NOT NULL DEFAULT TRUE,
  notify_news BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) One-time codes for logging in from a normal browser (/login in the bot)
CREATE TABLE IF NOT EXISTS login_codes (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(telegram_user_id, created_at DESC);

-- 3) Referrals
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by) WHERE referred_by IS NOT NULL;
CREATE TABLE IF NOT EXISTS referral_rewards (
  id BIGSERIAL PRIMARY KEY,
  referrer_id BIGINT NOT NULL REFERENCES users(id),
  referred_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  payment_id UUID,
  days_granted INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) Plan-expiry reminders (one message per subscription and window)
CREATE TABLE IF NOT EXISTS expiry_reminders (
  subscription_id BIGINT NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, kind)
);

-- 5) Admin broadcasts (queued, sent by the 5-minute worker)
CREATE TABLE IF NOT EXISTS broadcasts (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT REFERENCES users(id),
  text TEXT NOT NULL,
  audience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','done')),
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS broadcast_queue (
  id BIGSERIAL PRIMARY KEY,
  broadcast_id BIGINT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  picked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_todo ON broadcast_queue(status, id);

-- 6) Alerts muted by the user's notification preference are kept in history as 'muted'
ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_delivery_status_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_delivery_status_check CHECK (delivery_status IN ('pending','sent','failed','muted'));

COMMIT;
