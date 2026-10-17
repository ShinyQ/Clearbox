-- Migration number: 0003 	 2026-10-17T00:00:00.000Z
-- Accuracy and learning (contracts 12.10): decision segments, per-suggestion trash threshold, stored model output.

ALTER TABLE suggestions ADD COLUMN segment TEXT
  CHECK (segment IS NULL OR segment IN ('rule', 'sender', 'domain', 'bulk', 'other'));
-- The trash threshold a delete suggestion passed (0 for an Always OK to trash rule); NULL for other actions.
ALTER TABLE suggestions ADD COLUMN delete_tau REAL CHECK (delete_tau IS NULL OR delete_tau BETWEEN 0 AND 1);
-- Raw Decision-1 action distribution {"delete":..,"archive":..,"keep":..,"unsure":..}; lets a pending suggestion be
-- re-fused with newer priors, rules and thresholds without another model call.
ALTER TABLE suggestions ADD COLUMN model_action_json TEXT;

ALTER TABLE labels ADD COLUMN segment TEXT
  CHECK (segment IS NULL OR segment IN ('rule', 'sender', 'domain', 'bulk', 'other'));

-- Classify existing labels with the evidence that existed when their suggestion was made: owner decisions on the
-- same sender (then domain) before the suggestion was created, else bulk headers, else other.
UPDATE labels SET segment = CASE
  WHEN labels.sender <> '' AND (
    SELECT COUNT(*) FROM labels l2
    WHERE l2.account_id = labels.account_id AND l2.sender = labels.sender
      AND l2.created_at < COALESCE(
        (SELECT s.created_at FROM suggestions s WHERE s.message_id = labels.message_id), labels.created_at)
  ) >= 3 THEN 'sender'
  WHEN labels.sender_domain <> '' AND (
    SELECT COUNT(*) FROM labels l2
    WHERE l2.account_id = labels.account_id AND l2.sender_domain = labels.sender_domain
      AND l2.created_at < COALESCE(
        (SELECT s.created_at FROM suggestions s WHERE s.message_id = labels.message_id), labels.created_at)
  ) >= 3 THEN 'domain'
  WHEN EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = labels.message_id AND m.account_id = labels.account_id AND (
      json_extract(m.signals_json, '$.hasListUnsubscribe') = 1
      OR json_extract(m.signals_json, '$.hasListId') = 1
      OR json_extract(m.signals_json, '$.precedenceBulk') = 1
      OR json_extract(m.signals_json, '$.category') IN ('promotions', 'social', 'updates', 'forums'))
  ) THEN 'bulk'
  ELSE 'other'
END
WHERE segment IS NULL;

-- Open suggestions made before this migration have no stored model output, and many were frozen at keep by the
-- old "too recent" cap or fused before any owner decision existed. Queue them for one fresh decision (the next
-- ticks re-decide them with today's priors, rules and thresholds; recent mail is held until old enough).
UPDATE suggestions SET status = 'awaiting_model', action = NULL, confidence = NULL, decision_attempts = 0,
  retry_after = CAST(strftime('%s', 'now') AS INTEGER) * 1000, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'pending' AND model_action_json IS NULL;
