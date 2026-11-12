-- Launch limits, self-serve package pricing, and contract tracking support.
BEGIN;
UPDATE subscription_plans SET
  price_usdt = CASE code WHEN 'pro' THEN 1 WHEN 'business' THEN 2.5 WHEN 'enterprise' THEN 5 ELSE price_usdt END,
  duration_days = CASE WHEN code='free' THEN NULL ELSE 30 END,
  features = CASE code
    WHEN 'free' THEN '["10 wallet tracking","10 contract tracking","500 wallet transaction notifications/day","500 contract transaction notifications/day","50 alerts/day"]'::jsonb
    WHEN 'pro' THEN '["25 wallet tracking","25 contract tracking","1,500 wallet transaction notifications/day","1,500 contract transaction notifications/day","150 alerts/day"]'::jsonb
    WHEN 'business' THEN '["50 wallet tracking","50 contract tracking","5,000 wallet transaction notifications/day","5,000 contract transaction notifications/day","500 alerts/day"]'::jsonb
    WHEN 'enterprise' THEN '["100 wallet tracking","100 contract tracking","10,000 wallet transaction notifications/day","10,000 contract transaction notifications/day","1,000 alerts/day"]'::jsonb
    ELSE features END,
  updated_at=NOW()
WHERE code IN ('free','pro','business','enterprise');
ALTER TABLE onchain_alerts DROP CONSTRAINT IF EXISTS onchain_alerts_kind_check;
ALTER TABLE onchain_alerts ADD CONSTRAINT onchain_alerts_kind_check CHECK (kind IN ('wallet','contract','whale'));
ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_delivery_status_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_delivery_status_check CHECK (delivery_status IN ('pending','sent','failed','muted'));
COMMIT;
