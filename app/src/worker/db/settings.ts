import { parsePolicy, TAU_DELETE_DEFAULT } from "@clearbox/core";
import type { CalibrationResult, Policy } from "@clearbox/core";
import { z } from "zod";
import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import { toIso } from "./sql.ts";

export type SettingKey = "tau_delete" | "policy" | "policy_version" | "calibration" | "issues" | "nightly";

export type CalibrationSetting = CalibrationResult & { ranAt: number };

export interface NightlySetting {
  ranAt: number;
  purgedMessages: number;
  purgedAccounts: number;
  staleRecovered: number;
}

export interface Settings {
  tauDelete: number;
  policy: Policy;
  policyVersion: number;
  calibration: CalibrationSetting | null;
  issues: AppIssue[];
  nightly: NightlySetting | null;
}

export interface SettingRow {
  key: string;
  value: string;
}

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
  return {
    tauDelete: typeof tau === "number" ? tau : TAU_DELETE_DEFAULT,
    policy: parsePolicy(map.get("policy") ?? null),
    policyVersion: typeof version === "number" ? version : 1,
    calibration: (json("calibration") as CalibrationSetting | null) ?? null,
    issues: issues.success ? (issues.data as AppIssue[]) : [],
    nightly: (json("nightly") as NightlySetting | null) ?? null,
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
