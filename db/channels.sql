BEGIN;

-- Telegram channels / groups the bot posts to. One row per (chat, blockchain).
-- Unlimited: there is no plan limit, only admins can create them.
CREATE TABLE IF NOT EXISTS broadcast_channels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  chat_id TEXT NOT NULL,                       -- "@channelname" or numeric "-100..." id
  network TEXT NOT NULL DEFAULT 'all',         -- ethereum|bsc|polygon|arbitrum|base|optimism|avalanche|tron|solana|ton|all
  enabled BOOLEAN NOT NULL DEFAULT TRUE,       -- master ON/OFF for the whole channel
  last_error TEXT,
  last_posted_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, network)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_channels_network ON broadcast_channels(network, enabled);

-- Auto-alert rules of a channel. A channel can have any number of rules (also several of the same type).
CREATE TABLE IF NOT EXISTS channel_rules (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES broadcast_channels(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('price','new_token','liquidity','whale','movers','trending')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,       -- ON/OFF per rule
  schedule_type TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_type IN ('interval','daily')),
  interval_min INTEGER NOT NULL DEFAULT 60 CHECK (interval_min BETWEEN 5 AND 10080),
  daily_time TEXT,                             -- "HH:MM" in tz, only for schedule_type='daily'
  tz TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  last_posted_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_rules_channel ON channel_rules(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_channel_rules_due ON channel_rules(enabled, last_run_at NULLS FIRST);

-- Delivery log (kept 14 days by the worker).
CREATE TABLE IF NOT EXISTS channel_post_log (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES broadcast_channels(id) ON DELETE CASCADE,
  rule_id BIGINT REFERENCES channel_rules(id) ON DELETE SET NULL,
  alert_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_post_log_channel ON channel_post_log(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_post_log_time ON channel_post_log(created_at DESC);

COMMIT;
