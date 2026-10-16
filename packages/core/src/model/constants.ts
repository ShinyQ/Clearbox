// Fusion (spec 6.4)
export const PRIOR_MIN_N = 3;
export const PRIOR_LAMBDA_K = 5;
export const FLAG_THRESHOLD = 0.7;
export const RECORD_SHIFT = 0.5;
export const HUMAN_SHIFT = 0.5;
export const EXPIRED_SHIFT = 0.3;
export const EXPIRED_HUMAN_MAX = 0.5;
export const DELETE_MARGIN = 0.2;
export const MIN_CONFIDENCE = 0.55;
export const MAX_REASONS = 3;

// Calibration (spec 6.5)
export const TAU_DELETE_DEFAULT = 0.8;
export const TAU_DELETE_MIN = 0.8;
export const TAU_DELETE_MAX = 0.99;
export const TAU_STEP = 0.01;
export const CALIBRATION_WINDOW = 500;
export const CALIBRATION_MIN_DELETE_SUGGESTIONS = 50;
export const CALIBRATION_MIN_SUPPORT = 20;
export const CALIBRATION_TARGET_PRECISION = 0.98;

// Decision-1
export const DECISION_TIMEOUT_MS = 10_000;
export const DECISION_CONCURRENCY = 4;
export const DECISION_MAX_ATTEMPTS = 3;
export const DECISION_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const; // after attempt 1, after attempt 2
export const DECISION_STATE_MAX_CHARS = 1_750;
export const DECISION_SUBJECT_MAX_CHARS = 120;
export const DECISION_SNIPPET_MAX_CHARS = 300;
export const PAST_DECISIONS_MAX = 5;
export const PAST_DECISION_SUBJECT_MAX_CHARS = 60;
export const CHARS_PER_TOKEN_JSON = 3.5;
export const DECISION_TOKEN_TARGET = 800;

// Tick and providers
export const PAGE_SIZE_FREE = 25;
export const PAGE_SIZE_PAID = 100;
export const PAGE_SIZE_MIN = 5;
export const SENT_PAGE_SIZE = 100;
export const SENT_BACKFILL_MAX_MESSAGES = 1_000;
export const POLL_INTERVAL_MS = 30 * 60_000;
export const LEASE_TTL_MS = 5 * 60_000;
export const ACCESS_TOKEN_MIN_TTL_MS = 5 * 60_000;
export const TICK_SUBREQUEST_LIMIT = 45;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const DECISION_FAILURE_ABORT_RATIO = 0.5;

// D1 budget (Free: 100,000 rows written per day)
export const D1_DAILY_WRITE_LIMIT = 100_000;
export const BUDGET_ROWS_PER_DAY = 90_000; // 90% cap for everything
export const INGEST_STOP_ROWS = 65_000; // ticks are not claimed at or above this
export const PURGE_STOP_ROWS = 80_000; // nightly purge stops at or above this
export const STORAGE_SOFT_LIMIT_BYTES = 450_000_000; // of 500 MB per D1 database on Free

// Retention
export const PENDING_TTL_MS = 90 * 86_400_000;
export const DECIDED_TTL_MS = 30 * 86_400_000;
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;
export const BATCH_RETENTION_MS = 7 * 86_400_000;
export const STALE_APPROVED_MS = 10 * 60_000;

// Owner actions
export const MAX_ITEMS_PER_ACTION_REQUEST = 100;
export const LABEL_SUBJECT_MAX_CHARS = 60;
export const MESSAGE_SUBJECT_MAX_CHARS = 200;
