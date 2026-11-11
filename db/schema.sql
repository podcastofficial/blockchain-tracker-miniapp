BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_usdt NUMERIC(18,6) NOT NULL CHECK (price_usdt >= 0),
  duration_days INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_plans (code, name, price_usdt, duration_days, features)
VALUES
 ('free', 'Free', 0, NULL, '["Basic wallet watchlist","Limited alerts"]'::jsonb),
 ('pro', 'Pro', 1, 30, '["Expanded tracking","Advanced alerts"]'::jsonb),
 ('business', 'Business', 5, 30, '["Business monitoring","Higher limits"]'::jsonb),
 ('enterprise', 'Enterprise', 0, 30, '["Custom limits","Priority support"]'::jsonb)
ON CONFLICT (code) DO UPDATE SET
 name = EXCLUDED.name,
 price_usdt = EXCLUDED.price_usdt,
 duration_days = EXCLUDED.duration_days,
 features = EXCLUDED.features,
 updated_at = NOW();

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
  status TEXT NOT NULL CHECK (status IN ('active','expired','cancelled','pending')),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_status
  ON user_subscriptions(user_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
  chain TEXT NOT NULL CHECK (chain IN ('BEP20','TRC20')),
  token_symbol TEXT NOT NULL DEFAULT 'USDT',
  expected_amount NUMERIC(18,6) NOT NULL CHECK (expected_amount > 0),
  receiving_address TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','verifying','confirmed','rejected','expired')),
  confirmations INTEGER NOT NULL DEFAULT 0,
  provider_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE(chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user
  ON subscription_payments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
