import {
  DEFAULT_POLICY,
  buildReminderNote,
  countingFetch,
  parsePolicy,
  pendingTotal,
  reminderDue,
} from "@clearbox/core";
import type {
  FetchLike,
  ReminderCounts,
  SubrequestCounter,
  SuggestedAction,
  WeeklyReminder,
} from "@clearbox/core";
import { importEncKey } from "../crypto/aead.ts";
import { pendingByActionQuery } from "../db/suggestions.ts";
import { readConfig } from "../env.ts";
import { logEvent } from "../log.ts";
import { makeProvider } from "../scan/providers.ts";
import type { ProviderFactory, ProviderOAuthMap } from "../scan/providers.ts";
import { encryptTokenUpdate, openTickTokens, providerTargetOf } from "../scan/tick-tokens.ts";
import type { TickTokenRow } from "../scan/tick-tokens.ts";
import { rowsOf, settingStmt, stmt } from "../scan/write-plan.ts";
import type { BatchResult, BatchRunner, Stmt } from "../scan/write-plan.ts";

/**
 * Weekly "ready to clean" reminder (contracts 12.8), run by the nightly job before the purge. It adds a plain
 * text note to the owner's own inbox (Gmail messages.insert, Graph create in Inbox): no new scope, no domain,
 * nothing sent over SMTP. The tick never ingests the note (sender CLEARBOX_NOTE_SENDER).
 */

/** The account lease is held only for one insert; a crashed run frees it quickly. */
export const REMINDER_LEASE_TTL_MS = 120_000;
/** The 02:00 tick often holds the account lease for a few seconds: wait and retry the claim. */
export const REMINDER_LEASE_ATTEMPTS = 3;
export const REMINDER_LEASE_RETRY_MS = 15_000;
const DAY_MS = 86_400_000;
/**
 * Worst case: 3 claim attempts (D1) + token refresh 1 + insert 1 + 401 retry (refresh + insert) 2 + write (D1) 1.
 * Reserved before starting so the purge only gets what is left (contracts 8.6).
 */
export const REMINDER_MAX_SUBREQUESTS = 8;

/** Read in the nightly claim batch (no extra D1 call on the days the reminder is not due). */
export const REMINDER_SETTINGS_SQL =
  "SELECT key, value FROM settings WHERE key IN ('policy', 'reminder', 'app_origin')";
export const REMINDER_TARGETS_SQL =
  "SELECT id, email FROM accounts WHERE status = 'active' AND paused = 0 ORDER BY created_at, id";

/** Emails auto-trashed (contracts 12.11) in the 7 days before this run: (?1, ?2]. */
const AUTO_TRASHED_SQL = `SELECT COALESCE(SUM(json_extract(result_json, '$.delete')), 0) AS n FROM audit_log
WHERE kind = 'auto_trash' AND ts > ?1 AND ts <= ?2`;

/** Taken only when there is something to review in the visible accounts, or something was auto-trashed. */
const LEASE_CLAIM = (
  visible: number,
) => `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
SELECT 'account:' || ?1, ?1, ?2, ?3, ?4, NULL
WHERE EXISTS (SELECT 1 FROM suggestions WHERE account_id IN (${Array.from({ length: visible }, (_, i) => `?${i + 6}`).join(", ")}) AND status = 'pending')
  OR EXISTS (SELECT 1 FROM audit_log WHERE kind = 'auto_trash' AND ts > ?5 AND ts <= ?3 AND count > 0)
ON CONFLICT (name) DO UPDATE SET account_id = excluded.account_id, holder = excluded.holder,
  acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING holder`;

const TOKEN_ROW = `SELECT id, provider, email, key_version, enc_refresh_token, refresh_iv, enc_access_token, access_iv,
  access_expires_at, archive_folder_id FROM accounts WHERE id = ?1 AND status = 'active' AND paused = 0`;

const TOKEN_UPDATE = `UPDATE accounts SET enc_access_token = ?2, access_iv = ?3, access_expires_at = ?4,
    enc_refresh_token = COALESCE(?5, enc_refresh_token), refresh_iv = COALESCE(?6, refresh_iv), updated_at = ?7
  WHERE id = ?1 AND status <> 'disconnected'
    AND EXISTS (SELECT 1 FROM leases WHERE name = 'account:' || ?1 AND holder = ?8 AND released_at IS NULL)`;

const LEASE_RELEASE =
  "UPDATE leases SET released_at = ?3 WHERE name = 'account:' || ?1 AND holder = ?2 AND released_at IS NULL";

export type ReminderOutcome =
  "sent" | "nothing_to_review" | "no_account" | "busy" | "not_configured" | "no_budget" | "failed";

export interface ReminderSettings {
  reminder: WeeklyReminder;
  lastSentAt: number | null;
  origin: string | null;
}

interface SettingRow {
  key: string;
  value: string;
}

function jsonOf(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Never throws: an unreadable stored policy falls back to the default reminder, other values to null. */
export function parseReminderSettings(rows: readonly SettingRow[]): ReminderSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  let reminder = DEFAULT_POLICY.weeklyReminder;
  try {
    reminder = parsePolicy(map.get("policy") ?? null).weeklyReminder;
  } catch {
    // keep the default; the policy route reports invalid policies
  }
  const state = jsonOf(map.get("reminder"));
  const lastSentAt =
    state !== null &&
    typeof state === "object" &&
    "lastSentAt" in state &&
    typeof state.lastSentAt === "number"
      ? state.lastSentAt
      : null;
  const origin = jsonOf(map.get("app_origin"));
  return { reminder, lastSentAt, origin: typeof origin === "string" && origin !== "" ? origin : null };
}

/** The mailbox that gets the note: the one matching OWNER_EMAIL, else the oldest active, unpaused account. */
export function pickReminderTarget<T extends { email: string }>(
  targets: readonly T[],
  ownerEmail: string | null,
): T | null {
  return targets.find((t) => ownerEmail !== null && t.email === ownerEmail) ?? targets[0] ?? null;
}

export function countsOf(rows: readonly { action: SuggestedAction; n: number; g: number }[]): ReminderCounts {
  const pending: Record<SuggestedAction, number> = { delete: 0, archive: 0, keep: 0, unsure: 0 };
  let groups = 0;
  for (const r of rows) {
    if (r.action in pending) pending[r.action] += r.n;
    groups += r.g;
  }
  return { pending, groups };
}

export interface ReminderDeps {
  fetch: FetchLike;
  providerFactory: ProviderFactory;
  oauth?: ProviderOAuthMap;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_REMINDER_DEPS: ReminderDeps = {
  fetch: (input, init) => fetch(input, init),
  providerFactory: makeProvider,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ReminderRun {
  env: Env;
  run: BatchRunner;
  work: SubrequestCounter;
  runId: string;
  now: number;
  settings: ReminderSettings;
  targets: readonly { id: string; email: string }[];
  /** Accounts shown in Review (every non-disconnected account), the scope of the counts. */
  visibleIds: readonly string[];
  deps: ReminderDeps;
  /** Every D1 result, for the nightly row accounting. */
  results: BatchResult[];
}

/** Returns null when the reminder is not due today (nothing read, written or logged). */
export async function runWeeklyReminder(r: ReminderRun): Promise<ReminderOutcome | null> {
  if (!reminderDue(r.settings.reminder, r.settings.lastSentAt, r.now)) return null;
  let autoTrashed = 0;
  const log = (
    outcome: ReminderOutcome,
    extra: { accountId?: string; counts?: ReminderCounts; errorCode?: string } = {},
  ) => {
    logEvent("reminder.done", {
      runId: r.runId,
      outcome,
      accountId: extra.accountId ?? null,
      pending: extra.counts ? pendingTotal(extra.counts) : 0,
      groups: extra.counts?.groups ?? 0,
      autoTrashed,
      errorCode: extra.errorCode ?? null,
    });
    return outcome;
  };

  const cfg = readConfig(r.env);
  if (!cfg.ok) return log("not_configured");
  const target = pickReminderTarget(r.targets, cfg.config.ownerEmail);
  if (target === null || r.visibleIds.length === 0) return log("no_account");
  if (r.work.limit - r.work.used < REMINDER_MAX_SUBREQUESTS)
    return log("no_budget", { accountId: target.id });

  const counts = pendingByActionQuery(r.visibleIds);
  const since = r.now - 7 * DAY_MS;
  let claimed = false;
  let parsedCounts: ReminderCounts = countsOf([]);
  let row: (TickTokenRow & { email: string; archive_folder_id: string | null }) | undefined;
  for (let attempt = 1; attempt <= REMINDER_LEASE_ATTEMPTS && !claimed; attempt++) {
    if (attempt > 1) await r.deps.sleep(REMINDER_LEASE_RETRY_MS);
    const res = await r.run(r.work, [
      stmt(counts.sql, ...(counts.params as (string | number)[])),
      stmt(
        LEASE_CLAIM(r.visibleIds.length),
        target.id,
        r.runId,
        r.now,
        r.now + REMINDER_LEASE_TTL_MS,
        since,
        ...r.visibleIds,
      ),
      stmt(TOKEN_ROW, target.id),
      stmt(AUTO_TRASHED_SQL, since, r.now),
    ]);
    r.results.push(...res);
    parsedCounts = countsOf(rowsOf<{ action: SuggestedAction; n: number; g: number }>(res[0]));
    autoTrashed = rowsOf<{ n: number }>(res[3])[0]?.n ?? 0;
    if (pendingTotal(parsedCounts) === 0 && autoTrashed === 0)
      return log("nothing_to_review", { accountId: target.id, counts: parsedCounts });
    claimed = rowsOf(res[1]).length > 0;
    row = rowsOf<TickTokenRow & { email: string; archive_folder_id: string | null }>(res[2])[0];
  }
  if (!claimed) return log("busy", { accountId: target.id, counts: parsedCounts });

  const release = stmt(LEASE_RELEASE, target.id, r.runId, r.now);
  if (row === undefined) {
    r.results.push(...(await r.run(r.work, [release])));
    return log("no_account", { accountId: target.id, counts: parsedCounts });
  }

  const encKey = await importEncKey(cfg.config.tokenEncKey);
  const f = countingFetch(r.deps.fetch, r.work);
  const tokens = openTickTokens({
    row,
    config: cfg.config,
    encKey,
    fetch: f,
    now: r.now,
    ...(r.deps.oauth === undefined ? {} : { oauth: r.deps.oauth }),
  });
  const provider = r.deps.providerFactory(providerTargetOf(row), { fetch: f, tokens, now: () => r.now });
  const note = buildReminderNote({
    counts: parsedCounts,
    origin: r.settings.origin,
    to: row.email,
    now: r.now,
    autoTrashed,
  });
  let errorCode: string | null = null;
  try {
    await provider.insertInboxNote(note);
  } catch (err) {
    errorCode = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "internal";
  }

  // Rotated tokens are persisted even when the insert failed (Microsoft rotation must never be lost).
  const writes: Stmt[] = [];
  if (errorCode === null) writes.push(settingStmt("reminder", JSON.stringify({ lastSentAt: r.now }), r.now));
  if (tokens.update !== null) {
    const t = await encryptTokenUpdate(encKey, row, tokens.update);
    writes.push(
      stmt(
        TOKEN_UPDATE,
        row.id,
        t.encAccess,
        t.accessIv,
        t.accessExpiresAt,
        t.encRefresh,
        t.refreshIv,
        r.now,
        r.runId,
      ),
    );
  }
  writes.push(release);
  r.results.push(...(await r.run(r.work, writes)));
  return errorCode === null
    ? log("sent", { accountId: target.id, counts: parsedCounts })
    : log("failed", { accountId: target.id, counts: parsedCounts, errorCode });
}
