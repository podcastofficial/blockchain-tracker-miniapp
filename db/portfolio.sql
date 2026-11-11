BEGIN;
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_usd NUMERIC(24,6) NOT NULL,
  breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user ON portfolio_snapshots(user_id, taken_at DESC);
COMMIT;
