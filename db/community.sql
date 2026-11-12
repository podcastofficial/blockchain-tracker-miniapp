-- Phase 1: Community Crypto Monitor foundation (additive, safe to re-run).
-- Run once in Neon after db/profile.sql. Does not touch existing tables.
BEGIN;

-- Webhook idempotency: one row per Telegram update_id (retention handled by maintenance).
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id   BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_updates_received ON telegram_updates(received_at);

-- One row per Telegram group / supergroup / channel the bot belongs to.
CREATE TABLE IF NOT EXISTS communities (
  id                   BIGSERIAL PRIMARY KEY,
  chat_id              BIGINT UNIQUE NOT NULL,
  chat_type            TEXT NOT NULL CHECK (chat_type IN ('group','supergroup','channel')),
  title                TEXT,
  username             TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disconnected')),
  bot_status           TEXT,                       -- Telegram member status of the bot (member / administrator / ...)
  can_read_messages    BOOLEAN NOT NULL DEFAULT FALSE,
  can_post             BOOLEAN NOT NULL DEFAULT FALSE,
  added_by_telegram_id BIGINT,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_communities_status ON communities(status);

-- Cached Telegram administrators (authoritative check is still done live against Telegram).
CREATE TABLE IF NOT EXISTS community_admins (
  community_id     BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('creator','administrator')),
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, telegram_user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_admins_user ON community_admins(telegram_user_id);

-- Per-community settings (defaults match the plan; admins change them in later phases).
CREATE TABLE IF NOT EXISTS community_settings (
  community_id               BIGINT PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  auto_detect                BOOLEAN NOT NULL DEFAULT TRUE,
  command_detect             BOOLEAN NOT NULL DEFAULT TRUE,
  detect_wallets             BOOLEAN NOT NULL DEFAULT TRUE,
  detect_contracts           BOOLEAN NOT NULL DEFAULT TRUE,
  detect_tokens              BOOLEAN NOT NULL DEFAULT TRUE,
  networks                   TEXT[] NOT NULL DEFAULT '{}',
  dedupe_window_minutes      INTEGER NOT NULL DEFAULT 60 CHECK (dedupe_window_minutes BETWEEN 1 AND 10080),
  max_notifications_per_hour INTEGER NOT NULL DEFAULT 30 CHECK (max_notifications_per_hour BETWEEN 1 AND 600),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable audit trail of lifecycle and admin actions.
CREATE TABLE IF NOT EXISTS community_audit_logs (
  id                BIGSERIAL PRIMARY KEY,
  community_id      BIGINT REFERENCES communities(id) ON DELETE SET NULL,
  chat_id           BIGINT,
  actor_telegram_id BIGINT,
  action            TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_audit_community ON community_audit_logs(community_id, created_at DESC);

COMMIT;
