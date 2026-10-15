import { DEFAULT_POLICY } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  addIssue,
  issuesEqual,
  readSettings,
  removeIssue,
  setIssuesStmt,
  setSettingStmt,
} from "../../../src/worker/db/settings.ts";

const NOW = Date.UTC(2026, 9, 15, 12);

describe("settings repository", () => {
  it("returns migration defaults", async () => {
    const s = await readSettings(env.DB);
    expect(s.tauDelete).toBe(0.8);
    expect(s.policyVersion).toBe(1);
    expect(s.policy).toEqual(DEFAULT_POLICY);
    expect(s.calibration).toBeNull();
    expect(s.issues).toEqual([]);
    expect(s.nightly).toBeNull();
  });

  it("upserts JSON values", async () => {
    await env.DB.batch([
      setSettingStmt(env.DB, "tau_delete", 0.87, NOW),
      setSettingStmt(env.DB, "policy", { ...DEFAULT_POLICY, minAgeDays: 7 }, NOW),
    ]);
    const s = await readSettings(env.DB);
    expect(s.tauDelete).toBe(0.87);
    expect(s.policy.minAgeDays).toBe(7);
  });

  it("adds issues once per (code, account) and removes them", async () => {
    let issues = addIssue([], "storage_near_limit", null, NOW);
    issues = addIssue(issues, "storage_near_limit", null, NOW + 1);
    issues = addIssue(issues, "google_client_invalid", "acc_0000000000000001", NOW);
    expect(issues).toEqual([
      { code: "storage_near_limit", since: new Date(NOW).toISOString(), accountId: null },
      {
        code: "google_client_invalid",
        since: new Date(NOW).toISOString(),
        accountId: "acc_0000000000000001",
      },
    ]);
    expect(removeIssue(issues, "google_client_invalid")).toHaveLength(1);
    expect(removeIssue(issues, "google_client_invalid", "acc_ffffffffffffffff")).toHaveLength(2);
    expect(issuesEqual(issues, [...issues])).toBe(true);
    expect(issuesEqual(issues, issues.slice(1))).toBe(false);
    await setIssuesStmt(env.DB, issues, NOW).run();
    expect((await readSettings(env.DB)).issues).toEqual(issues);
  });
});
