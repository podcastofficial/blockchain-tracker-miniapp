-- Optional: the app creates this table automatically on first use. Run only if you prefer manual migrations.
CREATE TABLE IF NOT EXISTS smart_money_settings (
  user_id BIGINT PRIMARY KEY,
  auto_refresh BOOLEAN NOT NULL DEFAULT FALSE,
  alerts BOOLEAN NOT NULL DEFAULT FALSE,
  notified JSONB NOT NULL DEFAULT '{}',
  last_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
