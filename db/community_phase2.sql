-- Phase 2: community address records + usage counters (additive, safe to re-run). Run after db/community.sql.
BEGIN;

-- Community-level addresses. Deliberately separate from users' personal tracking (onchain_alerts / watchlists).
CREATE TABLE IF NOT EXISTS community_addresses (
  id                      BIGSERIAL PRIMARY KEY,
  community_id            BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  address                 TEXT NOT NULL,            -- as first submitted
  address_norm            TEXT NOT NULL,            -- EVM lower-cased, Tron/Solana unchanged
  family                  TEXT NOT NULL CHECK (family IN ('evm','tron','solana')),
  network                 TEXT,                     -- NULL while the chain is still ambiguous
  kind                    TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('unknown','wallet','contract','token')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_chain','active','removed')),
  source                  TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','command')),
  submitted_by_telegram_id BIGINT,
  hit_count               INTEGER NOT NULL DEFAULT 1,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_addresses
  ON community_addresses (community_id, address_norm, (COALESCE(network, '')));
CREATE INDEX IF NOT EXISTS idx_community_addresses_list
  ON community_addresses (community_id, status, last_seen_at DESC);

-- Hourly usage buckets: reply rate limiting + statistics (scanned messages, replies, addresses found).
CREATE TABLE IF NOT EXISTS community_usage (
  community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  hour_bucket  TIMESTAMPTZ NOT NULL,
  scanned      INTEGER NOT NULL DEFAULT 0,
  replies      INTEGER NOT NULL DEFAULT 0,
  addresses    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, hour_bucket)
);
COMMIT;
