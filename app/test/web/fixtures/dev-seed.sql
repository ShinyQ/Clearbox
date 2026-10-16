-- Synthetic local data for visual QA (plan 05 Task 26). Never apply to a remote database.
-- Apply to a freshly migrated local D1. Accounts carry dummy token bytes and a far-future next_tick_at,
-- so ticks never claim them; actions that reach a mailbox (Clean up, Undo, Scan now) fail by design.

UPDATE settings SET value = '0.86', updated_at = unixepoch() * 1000 WHERE key = 'tau_delete';
INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('issues', '[]', unixepoch() * 1000),
  ('calibration',
   '{"tauDelete":0.86,"changed":true,"outcome":"calibrated","deleteSuggestions":412,"precisionAtTau":0.986,'
   || '"points":[{"tau":0.8,"support":120,"precision":0.979},{"tau":0.86,"support":96,"precision":0.986},{"tau":0.9,"support":60,"precision":0.99}],'
   || '"ranAt":' || (unixepoch() * 1000 - 9 * 3600000) || '}',
   unixepoch() * 1000);

INSERT INTO accounts (id, provider, email, provider_user_id, status, status_reason, paused, key_version,
  enc_refresh_token, refresh_iv, granted_scopes, owner_aliases_json, archive_folder_id, phase, sent_scanned,
  backfill_done, incremental_cursor, page_size, next_tick_at, last_tick_at, messages_ingested, inbox_estimate,
  created_at, updated_at)
VALUES
  ('acc_00000000000000a1', 'gmail', 'you@example.com', 'seed-user-1', 'active', NULL, 0, 1, X'00', X'00',
   'https://www.googleapis.com/auth/gmail.modify', '[]', NULL, 'incremental', 1000, 1, 'seed-cursor-1', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 4 * 60000, 32118, NULL,
   unixepoch() * 1000 - 30 * 86400000, unixepoch() * 1000),
  ('acc_00000000000000a2', 'outlook', 'you@example.net', 'seed-user-2', 'active', NULL, 0, 1, X'00', X'00',
   'Mail.ReadWrite offline_access', '[]', 'seed-archive', 'inbox_backfill', 1000, 0, 'seed-cursor-2', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 60000, 8200, 20000,
   unixepoch() * 1000 - 2 * 86400000, unixepoch() * 1000),
  ('acc_00000000000000a3', 'gmail', 'work@example.org', 'seed-user-3', 'needs_reauth', 'invalid_grant', 0, 1, X'00', X'00',
   'https://www.googleapis.com/auth/gmail.modify', '[]', NULL, 'incremental', 1000, 1, 'seed-cursor-3', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 3 * 86400000, 5120, NULL,
   unixepoch() * 1000 - 60 * 86400000, unixepoch() * 1000);

WITH RECURSIVE
  g(gid, acc, sender, name, domain, action, base, n, subject, reasons, ceiling, applied) AS (VALUES
    (1, 'acc_00000000000000a1', 'promo@northwind.example', 'Northwind Deals', 'northwind.example', 'delete', 0.97, 48, 'Flash sale ends tonight',
     '[{"code":"prior_sender_deleted","params":{"deletes":41,"total":44}},{"code":"low_open_rate","params":{"openPct":2,"seen":52}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (2, 'acc_00000000000000a1', 'digest@news.example', 'Daily Digest', 'news.example', 'delete', 0.91, 36, 'Your morning digest',
     '[{"code":"bulk_mail","params":{}},{"code":"old_unread","params":{"ageDays":9}}]', 'delete', 0),
    (3, 'acc_00000000000000a2', 'orders@contoso.example', 'Contoso Orders', 'contoso.example', 'archive', 0.93, 22, 'Receipt for your order',
     '[{"code":"guard_record_pattern","params":{"pattern":"receipt"}}]', 'archive', 1),
    (4, 'acc_00000000000000a1', 'updates@fabrikam.example', 'Fabrikam Updates', 'fabrikam.example', 'archive', 0.79, 14, 'Release notes',
     '[{"code":"category","params":{"category":"updates"}}]', 'delete', 0),
    (5, 'acc_00000000000000a1', 'deals@tailspin.example', 'Tailspin Travel', 'tailspin.example', 'delete', 0.85, 19, 'Fares to the coast',
     '[{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (6, 'acc_00000000000000a2', 'mom@family.example', 'Mom', 'family.example', 'keep', 0.9, 3, 'Sunday lunch?',
     '[{"code":"guard_correspondent","params":{}}]', 'keep', 1),
    (7, 'acc_00000000000000a1', 'builds@ci.example', 'Build Bot', 'ci.example', 'unsure', 0.5, 9, 'Build finished',
     '[{"code":"low_confidence","params":{}}]', 'delete', 0),
    (8, 'acc_00000000000000a2', 'news@adventure-works.example', 'Adventure Works Weekly', 'adventure-works.example', 'delete', 0.96, 60, 'This week at Adventure Works',
     '[{"code":"prior_domain_deleted","params":{"deletes":30,"total":31,"domain":"adventure-works.example"}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (9, 'acc_00000000000000a1', 'alerts@litware.example', 'Litware Alerts', 'litware.example', 'archive', 0.88, 12, 'Your weekly alert summary',
     '[{"code":"auto_sent","params":{}}]', 'delete', 0),
    (10, 'acc_00000000000000a1', 'hello@proseware.example', 'Proseware', 'proseware.example', 'unsure', 0.4, 5, 'A note from Proseware',
     '[{"code":"model_unavailable","params":{}}]', 'delete', 0)),
  seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO messages (id, account_id, provider_msg_id, thread_id, internet_message_id, sender, sender_name, sender_domain,
  subject, snippet, received_at, is_read, signals_json, web_link, created_at)
SELECT gid * 1000 + i, acc, 'seed-' || gid || '-' || i, NULL, NULL, sender, name, domain,
  subject || ' (' || (i + 1) || ')', 'Synthetic preview text for message ' || (i + 1) || ' from ' || name || '.',
  unixepoch() * 1000 - (i + 1) * 3 * 3600000, i % 2,
  json_object('senderAddress', sender, 'senderDomain', domain, 'senderName', name, 'senderKnown', json('true'),
    'ownerReplied', json('false'), 'isCorrespondent', json(CASE WHEN gid = 6 THEN 'true' ELSE 'false' END),
    'senderSeenCount', n, 'senderOpenRate', 0.1, 'ownerDeleteRate', NULL, 'ownerDecisions', 0,
    'hasListUnsubscribe', json('true'), 'oneClickUnsubscribe', json('true'), 'hasListId', json('true'),
    'precedenceBulk', json('false'), 'autoSubmitted', json('false'), 'espDomain', NULL,
    'auth', json_object('spf', 'pass', 'dkim', 'pass', 'dmarc', 'pass'), 'category', NULL, 'starred', json('false'),
    'providerImportant', json('false'), 'ageDays', (i + 1) / 8, 'isRead', json(CASE WHEN i % 2 = 1 THEN 'true' ELSE 'false' END),
    'hasAttachments', json('false'), 'attachmentsApprox', json('false'), 'threadDepth', 1, 'ownerPosition', 'to'),
  CASE WHEN acc = 'acc_00000000000000a2' THEN 'https://outlook.office.com/mail/id/seed-' || gid || '-' || i ELSE NULL END,
  unixepoch() * 1000
FROM g JOIN seq ON seq.i < g.n;

WITH RECURSIVE
  g(gid, action, base, n, reasons, ceiling, applied) AS (VALUES
    (1, 'delete', 0.97, 48, '[{"code":"prior_sender_deleted","params":{"deletes":41,"total":44}},{"code":"low_open_rate","params":{"openPct":2,"seen":52}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (2, 'delete', 0.91, 36, '[{"code":"bulk_mail","params":{}},{"code":"old_unread","params":{"ageDays":9}}]', 'delete', 0),
    (3, 'archive', 0.93, 22, '[{"code":"guard_record_pattern","params":{"pattern":"receipt"}}]', 'archive', 1),
    (4, 'archive', 0.79, 14, '[{"code":"category","params":{"category":"updates"}}]', 'delete', 0),
    (5, 'delete', 0.85, 19, '[{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (6, 'keep', 0.9, 3, '[{"code":"guard_correspondent","params":{}}]', 'keep', 1),
    (7, 'unsure', 0.5, 9, '[{"code":"low_confidence","params":{}}]', 'delete', 0),
    (8, 'delete', 0.96, 60, '[{"code":"prior_domain_deleted","params":{"deletes":30,"total":31,"domain":"adventure-works.example"}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (9, 'archive', 0.88, 12, '[{"code":"auto_sent","params":{}}]', 'delete', 0),
    (10, 'unsure', 0.4, 5, '[{"code":"model_unavailable","params":{}}]', 'delete', 0)),
  seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, p_delete,
  ceiling, ceiling_applied, reasons_json, model_version, policy_version, decision_attempts, created_at, updated_at, expires_at)
SELECT m.id, m.account_id, m.sender, m.sender_domain, 'pending', g.action,
  MIN(1.0, g.base + 0.02 - (seq.i % 5) * 0.01),
  CASE WHEN g.action = 'delete' THEN MIN(1.0, g.base + 0.02 - (seq.i % 5) * 0.01) ELSE 0.05 END,
  g.ceiling, g.applied, g.reasons, 'decision-1', 1, 1, unixepoch() * 1000, unixepoch() * 1000, unixepoch() * 1000 + 90 * 86400000
FROM g JOIN seq ON seq.i < g.n JOIN messages m ON m.id = g.gid * 1000 + seq.i;

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action, owner_action, source,
  p_delete, margin, ceiling, model_version, policy_version, created_at, updated_at)
SELECT 'acc_00000000000000a1', NULL, 'old' || i || '@archive.example', 'archive.example', NULL, 'delete',
  CASE WHEN i = 7 THEN 'keep' ELSE 'delete' END, 'cleanup', 0.95, 0.4, 'delete', 'decision-1', 1,
  unixepoch() * 1000 - i * 3600000, unixepoch() * 1000 - i * 3600000
FROM seq;

INSERT INTO action_batches (id, created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at, undone_at) VALUES
  (1, unixepoch() * 1000 - 3600000, 'cleanup', '[]', 1284, 1280, 0, unixepoch() * 1000 + 23 * 3600000, NULL),
  (2, unixepoch() * 1000 - 3 * 3600000, 'approve', '[]', 248, 248, 0, unixepoch() * 1000 + 21 * 3600000, unixepoch() * 1000 - 2 * 3600000),
  (3, unixepoch() * 1000 - 2 * 86400000, 'override', '[]', 12, 12, 0, unixepoch() * 1000 - 86400000, NULL);

INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json) VALUES
  (unixepoch() * 1000 - 30 * 86400000, 'acc_00000000000000a1', 'account_connected', NULL, 0, '{}'),
  (unixepoch() * 1000 - 4 * 86400000, 'acc_00000000000000a3', 'reauth_required', NULL, 0, '{"reason":"invalid_grant"}'),
  (unixepoch() * 1000 - 3 * 86400000, NULL, 'purge', NULL, 4210, '{}'),
  (unixepoch() * 1000 - 3 * 86400000 + 60000, NULL, 'calibration', NULL, 312, '{"tauDelete":0.86}'),
  (unixepoch() * 1000 - 2 * 86400000 - 3600000, NULL, 'policy_updated', NULL, 0, '{"allow":3,"deny":1}'),
  (unixepoch() * 1000 - 2 * 86400000, 'acc_00000000000000a1', 'override', 3, 12,
   '{"executed":12,"failed":0,"skipped":0,"retryLater":0,"delete":12,"archive":0,"keep":0,"groups":1}'),
  (unixepoch() * 1000 - 3 * 3600000, 'acc_00000000000000a1', 'approve', 2, 248,
   '{"executed":248,"failed":0,"skipped":0,"retryLater":0,"delete":248,"archive":0,"keep":0,"groups":1}'),
  (unixepoch() * 1000 - 2 * 3600000, 'acc_00000000000000a1', 'undo', 2, 248, '{"restored":248,"failed":0}'),
  (unixepoch() * 1000 - 3600000, NULL, 'cleanup', 1, 1284,
   '{"executed":1280,"failed":0,"skipped":4,"retryLater":0,"delete":1102,"archive":178,"keep":0,"groups":371}');

INSERT OR REPLACE INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
  decision_input_tokens, provider_calls, db_size_bytes, updated_at)
VALUES (strftime('%Y-%m-%d', 'now'), 21080, 120000, 900, 3120, 3412, 2, 1400000, 2000, 182000000, unixepoch() * 1000);
