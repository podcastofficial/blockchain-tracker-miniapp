-- Phase 3: notification queue (additive, safe to re-run). Run after db/community_phase2.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS community_notifications (
  id                  BIGSERIAL PRIMARY KEY,
  community_id        BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  dedupe_key          TEXT NOT NULL,
  subject             JSONB NOT NULL,            -- { type:'address'|'tx', family, address|hash, norm, network?, addressId? }
  mode                TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','command','choice')),
  reply_to_message_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','retry','sent','dead','suppressed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at           TIMESTAMPTZ,
  last_error          TEXT,                       -- also holds the suppression reason (rate_limited, paused, type_disabled, ...)
  result_kind         TEXT,                       -- wallet | contract | token | tx
  telegram_message_id BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ
);
-- Same event can never be queued twice for one community (webhook retries, races, double clicks).
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_notifications_dedupe ON community_notifications (community_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_community_notifications_due ON community_notifications (status, next_attempt_at) WHERE status IN ('pending','retry','sending');
CREATE INDEX IF NOT EXISTS idx_community_notifications_community ON community_notifications (community_id, created_at DESC);

COMMIT;
