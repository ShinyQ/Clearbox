import { DEFAULT_POLICY, ProviderRateLimitError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNightly } from "../../../src/worker/nightly/nightly.ts";
import { REMINDER_LEASE_ATTEMPTS, REMINDER_LEASE_RETRY_MS } from "../../../src/worker/nightly/reminder.ts";
import type { ReminderDeps } from "../../../src/worker/nightly/reminder.ts";
import { FakeProvider } from "../helpers/fake-provider.ts";
import { ProviderMock, expectNoUnhandled, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  MINUTE,
  count,
  decryptAccountToken,
  holdLease,
  one,
  resetDb,
  seedExpiredBulk,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

/** Sunday 2026-10-18 02:00 UTC: the nightly cron on the default reminder day. */
const SUNDAY = Date.UTC(2026, 9, 18, 2);
const THURSDAY = SUNDAY - 3 * DAY;
const HOUR = 60 * MINUTE;
const ORIGIN = "https://clearbox.example.test";

afterEach(expectNoUnhandled);

async function setting<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?1", key);
  return row === null ? null : (JSON.parse(row.value) as T);
}

async function putSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

function reminderLogs(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"evt":"reminder.done"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function seedPending(
  accountId: string,
  n: number,
  action: "delete" | "archive" | "keep" | "unsure" = "delete",
) {
  for (let i = 0; i < n; i++) {
    await seedMessage(accountId, {
      providerId: `${accountId}-${action}-${i}`,
      sender: `s${i % 2}@shop.example`,
      action,
      expiresAt: SUNDAY + 30 * DAY,
    });
  }
}

describe("runNightly: weekly reminder (contracts 12.8)", () => {
  let fake: FakeProvider;
  let sleeps: number[];
  let deps: Partial<ReminderDeps>;
  const nightly = (now = SUNDAY, extra: Partial<ReminderDeps> = {}) =>
    runNightly(env, { now, reminder: { ...deps, ...extra } });

  beforeEach(async () => {
    await resetDb();
    fake = new FakeProvider();
    sleeps = [];
    deps = { providerFactory: fake.factory(), sleep: (ms) => (sleeps.push(ms), Promise.resolve()) };
    await seedTickAccount({ id: ACCOUNT_A, accessExpiresAt: SUNDAY + 30 * DAY });
    await putSetting("app_origin", ORIGIN);
    useNetwork();
  });

  it("adds one note to the inbox on the chosen weekday, with counts and links, and records the send", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedPending(ACCOUNT_A, 3, "delete");
    await seedPending(ACCOUNT_A, 2, "archive");
    await seedPending(ACCOUNT_A, 1, "unsure");

    await nightly();

    expect(fake.calls.map((c) => c.method)).toEqual(["insertInboxNote"]);
    expect(fake.calls[0]?.target.provider).toBe("outlook");
    const note = fake.notes[0];
    expect(note?.subject).toBe("Clearbox: 6 emails ready to review");
    expect(note?.to).toBe("owner@example.test");
    expect(note?.text).toContain("  Trash: 3\n  Archive: 2\n  Unsure: 1\n");
    expect(note?.text).toContain("5 sender groups need a decision.");
    expect(note?.text).toContain(`Review them: ${ORIGIN}/review`);
    expect(note?.text).toContain(`${ORIGIN}/rules`);
    expect(await setting("reminder")).toEqual({ lastSentAt: SUNDAY });
    const lease = await one<{ released_at: number | null }>(
      "SELECT released_at FROM leases WHERE name = 'account:' || ?1",
      ACCOUNT_A,
    );
    expect(lease?.released_at).toBe(SUNDAY);
    expect(reminderLogs(spy)).toEqual([
      expect.objectContaining({
        outcome: "sent",
        accountId: ACCOUNT_A,
        pending: 6,
        groups: 5,
        errorCode: null,
      }),
    ]);
    // Contracts 9: no address, subject or origin in the log line.
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/example\.test|ready to review/);
  });

  it("does nothing on other weekdays: no D1 reminder call, no provider call, no log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedPending(ACCOUNT_A, 2);
    for (let d = 1; d < 7; d++) await nightly(SUNDAY + d * DAY);
    expect(fake.calls).toEqual([]);
    expect(await setting("reminder")).toBeNull();
    expect(await count("leases", "name = 'account:' || ?1", ACCOUNT_A)).toBe(0);
    expect(reminderLogs(spy)).toEqual([]);
  });

  it("follows the owner's weekday and on/off choice", async () => {
    await seedPending(ACCOUNT_A, 2);
    await putSetting("policy", { ...DEFAULT_POLICY, weeklyReminder: { enabled: true, weekday: 4 } });
    await nightly(SUNDAY);
    expect(fake.notes).toHaveLength(0);
    await nightly(THURSDAY + 7 * DAY);
    expect(fake.notes).toHaveLength(1);

    await putSetting("policy", { ...DEFAULT_POLICY, weeklyReminder: { enabled: false, weekday: 4 } });
    await nightly(THURSDAY + 14 * DAY);
    expect(fake.notes).toHaveLength(1);
  });

  it("sends at most once per week, also when the nightly job runs twice on the same day", async () => {
    await seedPending(ACCOUNT_A, 2);
    await nightly(SUNDAY);
    await nightly(SUNDAY + HOUR);
    expect(fake.notes).toHaveLength(1);
    await nightly(SUNDAY + 7 * DAY);
    expect(fake.notes).toHaveLength(2);
  });

  it("sends nothing and takes no lease when there is nothing to review", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedMessage(ACCOUNT_A, { providerId: "done-1", status: "executed", expiresAt: SUNDAY + DAY });
    await nightly();
    expect(fake.calls).toEqual([]);
    expect(await setting("reminder")).toBeNull();
    expect(await count("leases", "name = 'account:' || ?1", ACCOUNT_A)).toBe(0);
    expect(reminderLogs(spy)).toEqual([
      expect.objectContaining({ outcome: "nothing_to_review", pending: 0 }),
    ]);
  });

  it("waits for a tick that holds the account lease, then sends", async () => {
    await seedPending(ACCOUNT_A, 1);
    await holdLease(ACCOUNT_A, "tick-1", SUNDAY);
    await nightly(SUNDAY, {
      sleep: async (ms) => {
        sleeps.push(ms);
        await env.DB.prepare("UPDATE leases SET released_at = ?1 WHERE holder = 'tick-1'").bind(SUNDAY).run();
      },
    });
    expect(sleeps).toEqual([REMINDER_LEASE_RETRY_MS]);
    expect(fake.notes).toHaveLength(1);
  });

  it("gives up after the lease attempts and does not mark the week as sent", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedPending(ACCOUNT_A, 1);
    await holdLease(ACCOUNT_A, "tick-1", SUNDAY);
    await nightly();
    expect(sleeps).toHaveLength(REMINDER_LEASE_ATTEMPTS - 1);
    expect(fake.calls).toEqual([]);
    expect(await setting("reminder")).toBeNull();
    expect(await one("SELECT holder FROM leases WHERE name = 'account:' || ?1", ACCOUNT_A)).toEqual({
      holder: "tick-1",
    });
    expect(reminderLogs(spy)).toEqual([expect.objectContaining({ outcome: "busy" })]);
  });

  it("logs a provider failure, releases the lease and still runs the purge", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fake.options = {
      failWith: {
        insertInboxNote: new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 60_000 }),
      },
    };
    await seedPending(ACCOUNT_A, 1);
    await seedMessage(ACCOUNT_A, { providerId: "old-1", status: "executed", expiresAt: SUNDAY - DAY });

    await nightly();

    expect(await setting("reminder")).toBeNull();
    expect(
      (
        await one<{ released_at: number | null }>(
          "SELECT released_at FROM leases WHERE name = 'account:' || ?1",
          ACCOUNT_A,
        )
      )?.released_at,
    ).toBe(SUNDAY);
    expect(await count("messages", "provider_msg_id = 'old-1'")).toBe(0);
    expect(await setting<{ purgedMessages: number }>("nightly")).toMatchObject({ purgedMessages: 1 });
    expect(reminderLogs(spy)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "provider_rate_limited" }),
    ]);
  });

  it("picks the mailbox matching OWNER_EMAIL, else the oldest active account, and counts every account", async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_B, email: "work@example.test", accessExpiresAt: SUNDAY + HOUR });
    await seedTickAccount({
      id: ACCOUNT_A,
      provider: "gmail",
      email: "owner@example.test",
      accessExpiresAt: SUNDAY + HOUR,
    });
    await seedPending(ACCOUNT_A, 1);
    await seedPending(ACCOUNT_B, 2, "keep");
    await nightly();
    expect(fake.calls[0]?.target.provider).toBe("gmail");
    expect(fake.notes[0]?.to).toBe("owner@example.test");
    expect(fake.notes[0]?.subject).toBe("Clearbox: 3 emails ready to review");

    await resetDb();
    await seedTickAccount({ id: ACCOUNT_B, email: "work@example.test", accessExpiresAt: SUNDAY + 8 * DAY });
    await seedTickAccount({ id: ACCOUNT_A, email: "other@example.test", paused: true });
    await seedPending(ACCOUNT_B, 1);
    await nightly(SUNDAY + 7 * DAY);
    expect(fake.notes[1]?.to).toBe("work@example.test");
  });

  it("refreshes an expired token and persists the rotated Microsoft tokens", async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A, accessExpiresAt: SUNDAY - HOUR });
    await seedPending(ACCOUNT_A, 1);
    const mock = new ProviderMock();
    useNetwork(mock.handlers());
    await nightly();
    expect(fake.notes).toHaveLength(1);
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("ms-access-2");
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("ms-refresh-2");
  });

  it("uses the real Graph provider within the nightly subrequest budget, purge included", async () => {
    await seedPending(ACCOUNT_A, 2);
    await seedExpiredBulk(ACCOUNT_A, 9_000, SUNDAY - DAY);
    const inserts: unknown[] = [];
    useNetwork([
      http.post("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages", async ({ request }) => {
        inserts.push(await request.json());
        return HttpResponse.json({ id: "AAMkNote0001" }, { status: 201 });
      }),
    ]);
    let batches = 0;
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (stmts: D1PreparedStatement[]) => {
        batches += 1;
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;

    await runNightly({ ...env, DB: db }, { now: SUNDAY, reminder: { sleep: () => Promise.resolve() } });

    expect(inserts).toHaveLength(1);
    expect(batches + inserts.length).toBeLessThanOrEqual(45);
    expect(await setting("reminder")).toEqual({ lastSentAt: SUNDAY });
  });
});
