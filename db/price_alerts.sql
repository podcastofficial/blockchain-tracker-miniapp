BEGIN;

CREATE TABLE IF NOT EXISTS price_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  coin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  target_price NUMERIC(38,12) NOT NULL CHECK (target_price > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','triggered')),
  triggered_price NUMERIC(38,12),
  triggered_at TIMESTAMPTZ,
  delivery_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(status, coin_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id, created_at DESC);
COMMIT;
