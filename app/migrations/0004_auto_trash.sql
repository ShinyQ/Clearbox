-- Migration number: 0004 	 2026-10-17T12:00:00.000Z
-- Auto-trash for trusted senders (contracts 12.11): action_batches and audit_log gain the 'auto_trash' kind.
-- SQLite cannot alter a CHECK constraint, so both tables are rebuilt. Neither has indexes and no table references
-- them by a foreign key, so ids and rows are copied as they are. action_batches keeps 7 days of rows and audit_log
-- is small, so the one-time write cost is low. suggestions.decided_via and labels.source are unchanged: an
-- automatic trash records decided_via = 'cleanup' (the batch kind tells them apart) and writes no label.

CREATE TABLE action_batches_new (
  id                   INTEGER PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('approve', 'override', 'cleanup', 'auto_trash')),
  suggestion_ids_json  TEXT NOT NULL,      -- JSON array of message_id integers, <= 100
  requested_count      INTEGER NOT NULL,
  executed_count       INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  undo_expires_at      INTEGER NOT NULL,
  undone_at            INTEGER
);
INSERT INTO action_batches_new (id, created_at, kind, suggestion_ids_json, requested_count, executed_count,
    failed_count, undo_expires_at, undone_at)
  SELECT id, created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at,
    undone_at FROM action_batches;
DROP TABLE action_batches;
ALTER TABLE action_batches_new RENAME TO action_batches;

CREATE TABLE audit_log_new (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  account_id  TEXT,                        -- no FK: audit rows outlive accounts
  kind        TEXT NOT NULL CHECK (kind IN (
                'account_connected', 'account_reconnected', 'account_disconnected', 'account_purged',
                'account_paused', 'account_resumed', 'reauth_required', 'config_error',
                'approve', 'override', 'cleanup', 'undo',
                'policy_updated', 'calibration', 'purge', 'unsubscribe', 'auto_trash')),
  batch_id    INTEGER,
  count       INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}'   -- counts and codes only, never addresses, subjects or URLs
);
INSERT INTO audit_log_new (id, ts, account_id, kind, batch_id, count, result_json)
  SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
