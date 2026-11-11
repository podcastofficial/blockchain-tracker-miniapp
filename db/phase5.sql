BEGIN;
-- Cloud-synced watchlist + invested amount (for P&L vs invested)
CREATE TABLE IF NOT EXISTS user_watchlists (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  invested_usd NUMERIC(24,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Smart-contract monitoring uses the same alert engine
ALTER TABLE onchain_alerts DROP CONSTRAINT IF EXISTS onchain_alerts_kind_check;
ALTER TABLE onchain_alerts ADD CONSTRAINT onchain_alerts_kind_check CHECK (kind IN ('wallet','whale','contract'));
COMMIT;
