-- Migration number: 0001 	 2026-10-15T00:00:00.000Z

CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY CHECK (length(id) = 20 AND id GLOB 'acc_[0-9a-f]*'),
  provider            TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email               TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  provider_user_id    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'needs_reauth', 'config_error', 'disconnected')),
  status_reason       TEXT,
  paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  key_version         INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  enc_refresh_token   BLOB,
  refresh_iv          BLOB,
  enc_access_token    BLOB,
  access_iv           BLOB,
  access_expires_at   INTEGER,
  granted_scopes      TEXT NOT NULL,
  owner_aliases_json  TEXT NOT NULL DEFAULT '[]',
  archive_folder_id   TEXT,
  phase               TEXT NOT NULL DEFAULT 'sent_backfill'
                        CHECK (phase IN ('sent_backfill', 'inbox_backfill', 'incremental')),
  sent_cursor         TEXT,
  sent_scanned        INTEGER NOT NULL DEFAULT 0 CHECK (sent_scanned >= 0),
  backfill_cursor     TEXT,
  backfill_done       INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
  incremental_cursor  TEXT NOT NULL,
  last_incremental_at INTEGER,
  watermark_received_at INTEGER,
  page_size           INTEGER NOT NULL DEFAULT 25 CHECK (page_size BETWEEN 5 AND 100),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  backoff_until       INTEGER,
  next_tick_at        INTEGER NOT NULL DEFAULT 0,
  last_tick_at        INTEGER,
  tick_started_at     INTEGER,
  tick_finished_at    INTEGER,
  last_error          TEXT,
  messages_ingested   INTEGER NOT NULL DEFAULT 0,
  inbox_estimate      INTEGER CHECK (inbox_estimate IS NULL OR inbox_estimate >= 0), -- rev 2.1 A4
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((enc_refresh_token IS NULL) = (refresh_iv IS NULL)),
  CHECK ((enc_access_token IS NULL) = (access_iv IS NULL)),
  CHECK (status = 'disconnected' OR enc_refresh_token IS NOT NULL)
);
CREATE UNIQUE INDEX accounts_provider_email ON accounts (provider, email) WHERE status <> 'disconnected';

CREATE TABLE leases (
  name         TEXT PRIMARY KEY,           -- 'account:<account_id>' or 'nightly'
  account_id   TEXT,
  holder       TEXT NOT NULL,              -- tick id / run id (uuid)
  acquired_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  released_at  INTEGER
) WITHOUT ROWID;

CREATE TABLE messages (
  id                  INTEGER PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts (id),
  provider_msg_id     TEXT NOT NULL,
  thread_id           TEXT,
  internet_message_id TEXT,
  sender              TEXT NOT NULL,       -- lowercased address, '' when unknown
  sender_name         TEXT,
  sender_domain       TEXT NOT NULL,       -- '' when unknown
  subject             TEXT,                -- <= 200 chars
  snippet             TEXT,                -- NULL when policy.storeSnippets = false
  received_at         INTEGER NOT NULL,
  is_read             INTEGER NOT NULL CHECK (is_read IN (0, 1)),
  signals_json        TEXT NOT NULL,
  web_link            TEXT,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_account_provider_id ON messages (account_id, provider_msg_id);

CREATE TABLE suggestions (
  message_id         INTEGER PRIMARY KEY REFERENCES messages (id),
  account_id         TEXT NOT NULL REFERENCES accounts (id),
  sender             TEXT NOT NULL,
  sender_domain      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN
                       ('awaiting_model', 'pending', 'approved', 'executed', 'failed', 'dismissed', 'undone')),
  action             TEXT CHECK (action IN ('delete', 'archive', 'keep', 'unsure')),
  confidence         REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  p_delete           REAL CHECK (p_delete IS NULL OR p_delete BETWEEN 0 AND 1),
  p_archive          REAL CHECK (p_archive IS NULL OR p_archive BETWEEN 0 AND 1),
  p_keep             REAL CHECK (p_keep IS NULL OR p_keep BETWEEN 0 AND 1),
  p_unsure           REAL CHECK (p_unsure IS NULL OR p_unsure BETWEEN 0 AND 1),
  model_p_delete     REAL CHECK (model_p_delete IS NULL OR model_p_delete BETWEEN 0 AND 1),
  margin             REAL,
  importance         REAL CHECK (importance IS NULL OR importance BETWEEN 0 AND 4),
  flags_json         TEXT,                 -- {"isRecord":0.03,"isExpired":0.91,"isFromHuman":0.01}
  ceiling            TEXT NOT NULL CHECK (ceiling IN ('keep', 'archive', 'delete')),
  ceiling_applied    INTEGER NOT NULL DEFAULT 0 CHECK (ceiling_applied IN (0, 1)),
  reasons_json       TEXT NOT NULL DEFAULT '[]',
  model_version      TEXT,
  policy_version     INTEGER NOT NULL,
  decision_attempts  INTEGER NOT NULL DEFAULT 0,
  retry_after        INTEGER,
  final_action       TEXT CHECK (final_action IN ('delete', 'archive', 'keep')),
  decided_via        TEXT CHECK (decided_via IN ('approve', 'override', 'cleanup')),
  batch_id           INTEGER,
  label_id           INTEGER,
  exec_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  expires_at         INTEGER NOT NULL,
  CHECK (status = 'awaiting_model' OR action IS NOT NULL),
  CHECK (status NOT IN ('executed', 'undone') OR final_action IS NOT NULL)
);
-- OR form on purpose: SQLite proves "status = 'pending'" implies this predicate, but not an IN (...) predicate.
CREATE INDEX suggestions_open ON suggestions (account_id, status, sender)
  WHERE status = 'pending' OR status = 'awaiting_model';

CREATE TABLE labels (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  message_id       INTEGER,                -- loose reference; message rows are purged
  sender           TEXT NOT NULL,
  sender_domain    TEXT NOT NULL,
  subject_trunc    TEXT,                   -- <= 60 chars; NULL when policy.labelSubjects = false
  suggested_action TEXT NOT NULL CHECK (suggested_action IN ('delete', 'archive', 'keep', 'unsure')),
  owner_action     TEXT NOT NULL CHECK (owner_action IN ('delete', 'archive', 'keep')),
  source           TEXT NOT NULL CHECK (source IN ('approve', 'override', 'cleanup', 'undo')),
  p_delete         REAL,
  margin           REAL,
  ceiling          TEXT NOT NULL CHECK (ceiling IN ('keep', 'archive', 'delete')),
  model_version    TEXT,
  policy_version   INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX labels_account_sender ON labels (account_id, sender);
CREATE INDEX labels_account_domain ON labels (account_id, sender_domain);

CREATE TABLE sender_priors (
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  key         TEXT NOT NULL,               -- 'user@example.com' or '@example.com'
  deletes     INTEGER NOT NULL DEFAULT 0 CHECK (deletes >= 0),
  keeps       INTEGER NOT NULL DEFAULT 0 CHECK (keeps >= 0),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
) WITHOUT ROWID;

CREATE TABLE senders (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  address       TEXT NOT NULL,
  domain        TEXT NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  read_count    INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TABLE correspondents (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  address       TEXT NOT NULL,
  last_sent_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TABLE sent_threads (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  thread_id     TEXT NOT NULL,
  last_sent_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id)
) WITHOUT ROWID;

CREATE TABLE action_batches (
  id                   INTEGER PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('approve', 'override', 'cleanup')),
  suggestion_ids_json  TEXT NOT NULL,      -- JSON array of message_id integers, <= 100
  requested_count      INTEGER NOT NULL,
  executed_count       INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  undo_expires_at      INTEGER NOT NULL,
  undone_at            INTEGER
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  account_id  TEXT,                        -- no FK: audit rows outlive accounts
  kind        TEXT NOT NULL CHECK (kind IN (
                'account_connected', 'account_reconnected', 'account_disconnected', 'account_purged',
                'account_paused', 'account_resumed', 'reauth_required', 'config_error',
                'approve', 'override', 'cleanup', 'undo',
                'policy_updated', 'calibration', 'purge')),
  batch_id    INTEGER,
  count       INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}'   -- counts and codes only, never addresses or subjects
);

CREATE TABLE budget (
  date                  TEXT PRIMARY KEY CHECK (length(date) = 10),  -- 'YYYY-MM-DD' UTC
  rows_written          INTEGER NOT NULL DEFAULT 0,
  rows_read             INTEGER NOT NULL DEFAULT 0,
  ticks                 INTEGER NOT NULL DEFAULT 0,
  messages_ingested     INTEGER NOT NULL DEFAULT 0,
  decision_calls        INTEGER NOT NULL DEFAULT 0,
  decision_failures     INTEGER NOT NULL DEFAULT 0,
  decision_input_tokens INTEGER NOT NULL DEFAULT 0,
  provider_calls        INTEGER NOT NULL DEFAULT 0,
  db_size_bytes         INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,               -- JSON
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO settings (key, value, updated_at) VALUES
  ('tau_delete', '0.8', 0),
  ('policy_version', '1', 0);
