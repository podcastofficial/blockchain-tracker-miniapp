-- OPTIONAL: the app creates these tables automatically on first use. Run this only if you prefer to create them by hand.
BEGIN;
CREATE TABLE IF NOT EXISTS force_join_settings (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), enabled BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS force_join_items (
  id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','group')),
  chat_ref TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO force_join_settings (id, enabled) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING;
INSERT INTO force_join_items (title, kind, chat_ref, url, sort_order) VALUES
 ('Multi Chain Tracker Channel','channel','@MultiChainTrackerChannel','https://t.me/MultiChainTrackerChannel',1),
 ('Multi Chain Community','group','@MultiChainCommunity','https://t.me/MultiChainCommunity',2)
ON CONFLICT (chat_ref) DO NOTHING;
COMMIT;
