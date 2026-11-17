-- Part 1: per-user custodial wallet (deposit addresses, balances, ledger, deposits, withdrawals).
-- Safe to run many times. The API also runs this automatically on first use.
CREATE SEQUENCE IF NOT EXISTS wallet_index_seq START 1;

CREATE TABLE IF NOT EXISTS wallet_assets (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,                       -- e.g. usdt-bsc
  symbol TEXT NOT NULL,
  chain TEXT NOT NULL,                             -- ethereum, bsc, polygon, arbitrum, base, optimism, avalanche, tron, solana
  network TEXT NOT NULL,                           -- key family: evm | tron | solana
  kind TEXT NOT NULL CHECK (kind IN ('native','token')),
  contract TEXT,
  decimals INTEGER NOT NULL,
  min_deposit NUMERIC(38,18) NOT NULL DEFAULT 0,
  min_withdraw NUMERIC(38,18) NOT NULL DEFAULT 0,
  withdraw_fee NUMERIC(38,18) NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL DEFAULT 12,
  deposit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  withdraw_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS wallets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_index INTEGER UNIQUE NOT NULL DEFAULT nextval('wallet_index_seq'),
  seed_fp TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_addresses (
  id BIGSERIAL PRIMARY KEY,
  wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network TEXT NOT NULL CHECK (network IN ('evm','tron','solana')),
  address TEXT NOT NULL,
  derivation_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_id, network)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_addr ON wallet_addresses (network, lower(address));
CREATE INDEX IF NOT EXISTS idx_wallet_addr_user ON wallet_addresses (user_id);

CREATE TABLE IF NOT EXISTS user_balances (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
  available NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (available >= 0),
  locked NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','withdraw_lock','withdraw_fee','withdraw_complete','withdraw_release','adjustment')),
  delta_available NUMERIC(38,18) NOT NULL DEFAULT 0,
  delta_locked NUMERIC(38,18) NOT NULL DEFAULT 0,
  available_after NUMERIC(38,18) NOT NULL,
  locked_after NUMERIC(38,18) NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotency: the same deposit / withdrawal event can never be booked twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_ref ON ledger_entries (kind, ref_type, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries (user_id, id DESC);

CREATE TABLE IF NOT EXISTS deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  from_address TEXT,
  to_address TEXT NOT NULL,
  amount NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  block_number BIGINT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited','ignored')),
  sweep_status TEXT NOT NULL DEFAULT 'none' CHECK (sweep_status IN ('none','queued','done','failed')),
  sweep_tx TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at TIMESTAMPTZ,
  UNIQUE (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_pending ON deposits (status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES wallet_assets(id),
  chain TEXT NOT NULL,
  to_address TEXT NOT NULL,
  memo TEXT,
  amount NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  fee NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','sent','rejected','failed','cancelled')),
  tx_hash TEXT,
  error TEXT,
  reviewed_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_open ON withdrawals (status) WHERE status IN ('pending','approved','processing');

CREATE TABLE IF NOT EXISTS chain_cursors (
  chain TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
