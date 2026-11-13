-- Phase 3b: remember the display name (token name / symbol) of each notification so the "Save" button can label saved items.
-- Safe to re-run. The bot works without it (it falls back to "<Network> 0x1234…abcd").
ALTER TABLE community_notifications ADD COLUMN IF NOT EXISTS display_name TEXT;
