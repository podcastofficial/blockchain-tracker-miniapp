-- Unified watches for ANY chat (private, group, supergroup, channel). Safe to re-run.
-- Run in Neon after db/community_contracts.sql.
BEGIN;

-- Wallet (incoming/outgoing) and smart-contract activity watches.
CREATE TABLE IF NOT EXISTS chat_watches (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      BIGINT NOT NULL,
  chat_type    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('wallet','contract')),
  network      TEXT NOT NULL,
  address      TEXT NOT NULL,
  address_norm TEXT NOT NULL,
  min_usd      NUMERIC(24,2) NOT NULL DEFAULT 1 CHECK (min_usd > 0),   -- <= 1 means "track every transfer"
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','removed')),
  state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at  TIMESTAMPTZ,
  last_error   TEXT,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, kind, network, address_norm)
);
CREATE INDEX IF NOT EXISTS idx_chat_watches_run  ON chat_watches(status, last_run_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_chat_watches_chat ON chat_watches(chat_id, status);

-- Delivered-event ledger (dedupe so a retried scan never double-posts).
CREATE TABLE IF NOT EXISTS chat_watch_events (
  watch_id   BIGINT NOT NULL REFERENCES chat_watches(id) ON DELETE CASCADE,
  tx_key     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watch_id, tx_key)
);
CREATE INDEX IF NOT EXISTS idx_chat_watch_events_age ON chat_watch_events(created_at);

-- Token BUY/SELL watches can now also belong to a private chat (no communities row).
ALTER TABLE community_contract_watches ALTER COLUMN community_id DROP NOT NULL;
ALTER TABLE community_contract_watches ADD COLUMN IF NOT EXISTS chat_id BIGINT;
UPDATE community_contract_watches w SET chat_id = c.chat_id FROM communities c WHERE w.community_id = c.id AND w.chat_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ccw_chat ON community_contract_watches(chat_id, network, token_norm) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ccw_chat ON community_contract_watches(chat_id, status);

COMMIT;
