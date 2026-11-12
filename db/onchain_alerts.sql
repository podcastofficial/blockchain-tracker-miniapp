BEGIN;
CREATE TABLE IF NOT EXISTS onchain_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('wallet','contract','whale')),
  network TEXT NOT NULL,
  address TEXT,
  min_usd NUMERIC(24,2) NOT NULL DEFAULT 10 CHECK (min_usd > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE onchain_alerts DROP CONSTRAINT IF EXISTS onchain_alerts_kind_check;
ALTER TABLE onchain_alerts ADD CONSTRAINT onchain_alerts_kind_check CHECK (kind IN ('wallet','contract','whale'));
CREATE INDEX IF NOT EXISTS idx_onchain_alerts_run ON onchain_alerts(status, last_run_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_onchain_alerts_user ON onchain_alerts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES onchain_alerts(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  tx_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  network TEXT NOT NULL,
  summary TEXT NOT NULL,
  usd NUMERIC(24,2),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, tx_key)
);
ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_delivery_status_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_delivery_status_check CHECK (delivery_status IN ('pending','sent','failed','muted'));
CREATE INDEX IF NOT EXISTS idx_alert_events_user ON alert_events(user_id, created_at DESC);
COMMIT;
