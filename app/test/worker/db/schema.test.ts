import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TABLES = [
  "accounts",
  "action_batches",
  "audit_log",
  "budget",
  "correspondents",
  "labels",
  "leases",
  "messages",
  "sender_priors",
  "senders",
  "sent_threads",
  "settings",
  "suggestions",
];

describe("0001_init migration", () => {
  it("creates every table of contracts 6.1", async () => {
    const res = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).run<{ name: string }>();
    expect(res.results.map((r) => r.name)).toEqual(TABLES);
  });

  it("creates the partial open-suggestions index", async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'suggestions_open'").first<{
      sql: string;
    }>();
    expect(row?.sql).toContain("WHERE status = 'pending' OR status = 'awaiting_model'");
  });

  it("seeds tau_delete and policy_version", async () => {
    const res = await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").run<{
      key: string;
      value: string;
    }>();
    expect(res.results).toEqual([
      { key: "policy_version", value: "1" },
      { key: "tau_delete", value: "0.8" },
    ]);
  });

  it("adds the rev 2.1 inbox_estimate column to accounts", async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('accounts')").run<{
      name: string;
    }>();
    expect(cols.results.map((c) => c.name)).toContain("inbox_estimate");
  });

  it("rejects a malformed account id", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (id, provider, email, provider_user_id, granted_scopes, incremental_cursor, enc_refresh_token, refresh_iv, created_at, updated_at) VALUES ('bad', 'gmail', 'a@example.com', 'a@example.com', '', '{}', x'00', x'00', 0, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
