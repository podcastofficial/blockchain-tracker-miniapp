-- Command-only detection: the bot no longer scans normal messages (it answers /track and /tx only).
-- Keeps the stored setting consistent with the new behaviour. Safe to re-run; optional (the code ignores auto_detect now).
BEGIN;
ALTER TABLE community_settings ALTER COLUMN auto_detect SET DEFAULT FALSE;
UPDATE community_settings SET auto_detect = FALSE WHERE auto_detect IS DISTINCT FROM FALSE;
COMMIT;
