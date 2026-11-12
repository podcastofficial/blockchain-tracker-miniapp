-- Launchpad (Meteora Dynamic Bonding Curve). Run in Neon after the older SQL files.
CREATE TABLE IF NOT EXISTS launch_tokens (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  creator       TEXT NOT NULL,               -- Solana wallet of the creator
  mint          TEXT UNIQUE NOT NULL,
  pool          TEXT NOT NULL,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  description   TEXT,
  twitter       TEXT,
  telegram      TEXT,
  website       TEXT,
  image         BYTEA,
  image_mime    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending -> live
  tx_sig        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  live_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS launch_tokens_status_idx ON launch_tokens (status, live_at DESC);
CREATE INDEX IF NOT EXISTS launch_tokens_user_idx   ON launch_tokens (user_id, created_at DESC);
