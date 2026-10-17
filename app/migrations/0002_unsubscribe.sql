-- Migration number: 0002 	 2026-10-17T00:00:00.000Z
-- Unsubscribe assistant (contracts 12.8).

-- One row per (account, sender) the owner unsubscribed from with RFC 8058 one-click. No URL is stored:
-- the Worker reads the List-Unsubscribe headers from the provider at request time. Kept while the account
-- exists (like sender_priors); the nightly purge deletes it with the other account-owned rows.
CREATE TABLE unsubscribes (
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  sender           TEXT NOT NULL CHECK (sender <> ''),
  unsubscribed_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, sender)
) WITHOUT ROWID;

-- audit_log gains the 'unsubscribe' kind. SQLite cannot alter a CHECK constraint, so the table is rebuilt;
-- no other table references audit_log and it has no indexes, so ids and rows are copied as they are.
CREATE TABLE audit_log_new (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  account_id  TEXT,                        -- no FK: audit rows outlive accounts
  kind        TEXT NOT NULL CHECK (kind IN (
                'account_connected', 'account_reconnected', 'account_disconnected', 'account_purged',
                'account_paused', 'account_resumed', 'reauth_required', 'config_error',
                'approve', 'override', 'cleanup', 'undo',
                'policy_updated', 'calibration', 'purge', 'unsubscribe')),
  batch_id    INTEGER,
  count       INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}'   -- counts and codes only, never addresses, subjects or URLs
);
INSERT INTO audit_log_new (id, ts, account_id, kind, batch_id, count, result_json)
  SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
