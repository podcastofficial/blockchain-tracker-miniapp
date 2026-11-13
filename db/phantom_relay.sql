-- Optional: the table is also created automatically on first use. Short-lived, holds only encrypted Phantom answers.
CREATE TABLE IF NOT EXISTS phantom_relay (
  sid        TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
