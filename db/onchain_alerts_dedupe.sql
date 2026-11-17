-- Safe, re-runnable deduplication for on-chain alert rules.
-- Keeps the oldest rule for each exact identity, preserves events, and leaves
-- a rule active if any duplicate was active. Different thresholds/types remain.
BEGIN;

CREATE TEMP TABLE _onchain_alert_dedupe_map ON COMMIT DROP AS
SELECT id,
       MIN(id) OVER (PARTITION BY user_id, kind, LOWER(network), LOWER(COALESCE(address,'')), min_usd) AS keep_id
FROM onchain_alerts;

-- Merge active/paused state and latest scan timestamp into the canonical rule.
WITH grouped AS (
  SELECT m.keep_id,
         BOOL_OR(a.status='active') AS has_active,
         MAX(a.last_run_at) AS latest_run
  FROM _onchain_alert_dedupe_map m
  JOIN onchain_alerts a ON a.id=m.id
  GROUP BY m.keep_id
)
UPDATE onchain_alerts a
SET status=CASE WHEN g.has_active THEN 'active' ELSE 'paused' END,
    last_run_at=g.latest_run
FROM grouped g
WHERE a.id=g.keep_id;

-- Deduplicate event history across all rules in each group before re-parenting.
-- Keep the oldest event row for each transaction key so UNIQUE(alert_id, tx_key) remains valid.
WITH ranked_events AS (
  SELECT e.id,
         ROW_NUMBER() OVER (PARTITION BY m.keep_id, e.tx_key ORDER BY e.id) AS rn
  FROM alert_events e
  JOIN _onchain_alert_dedupe_map m ON m.id=e.alert_id
)
DELETE FROM alert_events e
USING ranked_events r
WHERE e.id=r.id AND r.rn>1;

-- Preserve remaining event history under the canonical rule.
UPDATE alert_events e
SET alert_id=m.keep_id
FROM _onchain_alert_dedupe_map m
WHERE e.alert_id=m.id AND m.id<>m.keep_id;

-- Remove duplicate rule rows only after event history has been merged.
DELETE FROM onchain_alerts a
USING _onchain_alert_dedupe_map m
WHERE a.id=m.id AND m.id<>m.keep_id;

-- Enforce uniqueness for future inserts (including paused rules).
CREATE UNIQUE INDEX IF NOT EXISTS uq_onchain_alerts_exact_rule
ON onchain_alerts (user_id, kind, LOWER(network), LOWER(COALESCE(address,'')), min_usd);

COMMIT;
