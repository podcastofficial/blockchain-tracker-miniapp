-- Channel-scoped smart-contract BUY/SELL watchlist. Run after community_phase3b.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS community_contract_watches (
  id BIGSERIAL PRIMARY KEY,
  community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  network TEXT NOT NULL CHECK (network IN ('ethereum','bsc','polygon','arbitrum','base','optimism','avalanche')),
  token_address TEXT NOT NULL,
  token_norm TEXT NOT NULL,
  token_name TEXT,
  token_symbol TEXT,
  pair_address TEXT,
  pair_version TEXT,
  token0 TEXT,
  token1 TEXT,
  last_block BIGINT,
  status TEXT NOT NULL DEFAULT 'discovering' CHECK (status IN ('discovering','active','paused','error','removed')),
  last_error TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, network, token_norm)
);
CREATE INDEX IF NOT EXISTS idx_community_contract_watches_due ON community_contract_watches(status, updated_at);
CREATE TABLE IF NOT EXISTS community_contract_trades (
  id BIGSERIAL PRIMARY KEY,
  watch_id BIGINT NOT NULL REFERENCES community_contract_watches(id) ON DELETE CASCADE,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  trader TEXT,
  token_amount NUMERIC,
  quote_amount NUMERIC,
  quote_symbol TEXT,
  price_usd NUMERIC,
  block_number BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (watch_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_community_contract_trades_watch ON community_contract_trades(watch_id, created_at DESC);
COMMIT;
