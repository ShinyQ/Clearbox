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
  writePolicy,
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

  describe("writePolicy", () => {
    const policy = { ...DEFAULT_POLICY, allowlist: ["boss@example.com"], denylist: ["spam@example.org"] };

    /**
     * Runs each batch statement in its own batch, right after a no-op UPDATE of `rows` rows, so `changes()` never
     * carries over from the previous writePolicy statement. The writes still happen in batch order.
     */
    function noChangesCarryOver(db: D1Database, rows: 1 | 2): D1Database {
      const keys = rows === 1 ? "('tau_delete')" : "('tau_delete', 'policy_version')";
      const noise = db.prepare(`UPDATE settings SET updated_at = updated_at WHERE key IN ${keys}`);
      return {
        prepare: (query: string) => db.prepare(query),
        batch: async (stmts: D1PreparedStatement[]) => {
          const out: D1Result[] = [];
          for (const stmt of stmts) {
            const [, res] = await db.batch([noise, stmt]);
            if (res) out.push(res);
          }
          return out;
        },
      } as unknown as D1Database;
    }

    async function policyAudits(): Promise<unknown[]> {
      const res = await env.DB.prepare(
        "SELECT ts, result_json FROM audit_log WHERE kind = 'policy_updated' ORDER BY id",
      ).all();
      return res.results;
    }

    it("stores the policy, the audit row and the version without relying on changes()", async () => {
      const base = (await readSettings(env.DB)).policyVersion;
      const audits = await policyAudits();
      expect(await writePolicy(noChangesCarryOver(env.DB, 2), policy, base, NOW)).toBe(base + 1);
      const s = await readSettings(env.DB);
      expect(s.policyVersion).toBe(base + 1);
      expect(s.policy.allowlist).toEqual(["boss@example.com"]);
      expect(s.policy.denylist).toEqual(["spam@example.org"]);
      expect(await policyAudits()).toEqual([
        ...audits,
        { ts: NOW, result_json: JSON.stringify({ allow: 1, deny: 1 }) },
      ]);
    });

    it("changes nothing for a stale expected version, even in the same millisecond", async () => {
      const base = (await readSettings(env.DB)).policyVersion;
      const audits = (await policyAudits()).length;
      expect(await writePolicy(env.DB, policy, base, NOW)).toBe(base + 1);
      const stale = { ...DEFAULT_POLICY, minAgeDays: 9 };
      expect(await writePolicy(env.DB, stale, base, NOW)).toBeNull();
      expect(await writePolicy(noChangesCarryOver(env.DB, 1), stale, base, NOW)).toBeNull();
      expect(await writePolicy(noChangesCarryOver(env.DB, 2), stale, base, NOW)).toBeNull();
      const s = await readSettings(env.DB);
      expect(s.policyVersion).toBe(base + 1);
      expect(s.policy.allowlist).toEqual(["boss@example.com"]);
      expect(s.policy.minAgeDays).toBe(DEFAULT_POLICY.minAgeDays);
      expect(await policyAudits()).toHaveLength(audits + 1);
      expect(await writePolicy(env.DB, stale, base + 1, NOW + 1)).toBe(base + 2);
      expect((await readSettings(env.DB)).policy.minAgeDays).toBe(9);
      expect(await policyAudits()).toHaveLength(audits + 2);
    });
  });
});
