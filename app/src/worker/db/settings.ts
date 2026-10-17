import { parsePolicy, TAU_DELETE_DEFAULT } from "@clearbox/core";
import type { CalibrationResult, Policy, SegmentCalibration, SegmentTaus } from "@clearbox/core";
import { z } from "zod";
import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import { parseSegmentTaus } from "../scan/claim.ts";
import { toIso } from "./sql.ts";

export type SettingKey =
  | "tau_delete"
  | "policy"
  | "policy_version"
  | "calibration"
  | "issues"
  | "nightly"
  | "tau_segments"
  | "rule_dismissals";

/** contracts 12.10 adds `segments` (absent on rows written before it). */
export type CalibrationSetting = CalibrationResult & { ranAt: number; segments?: SegmentCalibration[] };

/** contracts 12.10: dismissed rule suggestions, newest last, at most RULE_DISMISSALS_MAX. */
export interface RuleDismissal {
  entry: string;
  list: "allow" | "deny";
  at: number;
}

export interface NightlySetting {
  ranAt: number;
  purgedMessages: number;
  purgedAccounts: number;
  staleRecovered: number;
  /** contracts 12.10: pending suggestions re-fused by this run (absent before it). */
  refreshed?: number;
}

export interface Settings {
  tauDelete: number;
  policy: Policy;
  policyVersion: number;
  calibration: CalibrationSetting | null;
  issues: AppIssue[];
  nightly: NightlySetting | null;
  /** contracts 12.10: null before the first segment calibration. */
  segmentTaus: SegmentTaus | null;
  ruleDismissals: RuleDismissal[];
}

export interface SettingRow {
  key: string;
  value: string;
}

const RuleDismissalsSchema = z.array(
  z.object({ entry: z.string(), list: z.enum(["allow", "deny"]), at: z.number() }),
);

const IssueListSchema = z.array(
  z.object({ code: z.string(), since: z.string(), accountId: z.string().nullable() }),
);

export function selectSettingsStmt(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT key, value FROM settings");
}

export function parseSettings(rows: readonly SettingRow[]): Settings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const json = (key: SettingKey): unknown => {
    const raw = map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as unknown);
  };
  const tau = json("tau_delete");
  const version = json("policy_version");
  const issues = IssueListSchema.safeParse(json("issues") ?? []);
  const dismissals = RuleDismissalsSchema.safeParse(json("rule_dismissals") ?? []);
  return {
    tauDelete: typeof tau === "number" ? tau : TAU_DELETE_DEFAULT,
    policy: parsePolicy(map.get("policy") ?? null),
    policyVersion: typeof version === "number" ? version : 1,
    calibration: (json("calibration") as CalibrationSetting | null) ?? null,
    issues: issues.success ? (issues.data as AppIssue[]) : [],
    nightly: (json("nightly") as NightlySetting | null) ?? null,
    segmentTaus: parseSegmentTaus(map.get("tau_segments") ?? null),
    ruleDismissals: dismissals.success ? dismissals.data : [],
  };
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const res = await selectSettingsStmt(db).run<SettingRow>();
  return parseSettings(res.results);
}

export function setSettingStmt(
  db: D1Database,
  key: SettingKey,
  value: unknown,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), now);
}

export function addIssue(
  issues: readonly AppIssue[],
  code: AppIssueCode,
  accountId: string | null,
  now: number,
): AppIssue[] {
  if (issues.some((i) => i.code === code && i.accountId === accountId)) return [...issues];
  return [...issues, { code, since: toIso(now), accountId }];
}

/** accountId undefined removes the code for every account. */
export function removeIssue(
  issues: readonly AppIssue[],
  code: AppIssueCode,
  accountId?: string | null,
): AppIssue[] {
  return issues.filter((i) => !(i.code === code && (accountId === undefined || i.accountId === accountId)));
}

export function issuesEqual(a: readonly AppIssue[], b: readonly AppIssue[]): boolean {
  const key = (i: AppIssue) => `${i.code}|${i.accountId ?? ""}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, idx) => k === right[idx]);
}

export function setIssuesStmt(db: D1Database, issues: readonly AppIssue[], now: number): D1PreparedStatement {
  return setSettingStmt(db, "issues", issues, now);
}

/**
 * Decision 25: policy upsert, audit insert and conditional version bump in one D1 batch (one transaction).
 * All three test the same predicate (stored version = expectedVersion), and the bump runs last, so they apply
 * together or not at all without relying on `changes()`. Returns the new version, or null when expectedVersion
 * is stale.
 *
 * Rev 2.4: `resumeBackfill` (the scan history window widened) also moves every account whose backfill stopped at
 * the old window edge (phase incremental, backfill_done 0) back to inbox_backfill under the same predicate; the
 * next tick resumes from its stored backfill_cursor. Accounts that scanned their whole inbox are untouched.
 */
export async function writePolicy(
  db: D1Database,
  policy: Policy,
  expectedVersion: number,
  now: number,
  opts: { resumeBackfill?: boolean } = {},
): Promise<number | null> {
  const result = { allow: policy.allowlist.length, deny: policy.denylist.length };
  const resume = opts.resumeBackfill === true ? [resumeWindowBackfillStmt(db, expectedVersion, now)] : [];
  const results = await db.batch([
    ...resume,
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         SELECT 'policy', ?1, ?2
         WHERE (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'policy_version') = ?3
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(policy), now, expectedVersion),
    db
      .prepare(
        `INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json)
         SELECT ?1, NULL, 'policy_updated', NULL, 0, ?2
         WHERE (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'policy_version') = ?3`,
      )
      .bind(now, JSON.stringify(result), expectedVersion),
    db
      .prepare(
        "UPDATE settings SET value = ?2, updated_at = ?3 WHERE key = 'policy_version' AND CAST(value AS INTEGER) = ?1",
      )
      .bind(expectedVersion, String(expectedVersion + 1), now),
  ]);
  return (results[resume.length + 2]?.meta.changes ?? 0) === 1 ? expectedVersion + 1 : null;
}

function resumeWindowBackfillStmt(db: D1Database, expectedVersion: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET phase = 'inbox_backfill', next_tick_at = MIN(next_tick_at, ?1), updated_at = ?1
       WHERE phase = 'incremental' AND backfill_done = 0 AND status <> 'disconnected'
         AND (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'policy_version') = ?2`,
    )
    .bind(now, expectedVersion);
}
