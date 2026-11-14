-- Editable alert text templates (admin panel). Safe to re-run. Run once in Neon.
-- No row = the built-in default template from lib/templates.js is used.
BEGIN;
CREATE TABLE IF NOT EXISTS alert_templates (
  key        TEXT PRIMARY KEY,
  text       TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 3000),
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;
