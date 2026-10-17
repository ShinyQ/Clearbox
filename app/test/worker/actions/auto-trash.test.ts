import { DEFAULT_POLICY, ProviderRateLimitError } from "@clearbox/core";
import type { Policy } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAutoTrash } from "../../../src/worker/actions/execute.ts";
import type { ActionContext } from "../../../src/worker/actions/execute.ts";
import { undoBatch } from "../../../src/worker/actions/undo.ts";
import { defaultDeps } from "../../../src/worker/app.ts";
import { readConfig } from "../../../src/worker/env.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import type { SeedSuggestionOptions } from "../helpers/seed.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;
const SENDER = "news@shop.example.com";
afterEach(() => vi.restoreAllMocks());

function context(provider: FakeProvider, db: D1Database = env.DB): ActionContext {
  const result = readConfig(env);
  if (!result.ok) throw new Error("config");
  return {
    db,
    config: result.config,
    deps: defaultDeps({ now: () => SEED_NOW, providerFactory: provider.factory(), oauth: fakeOAuth().oauth }),
    requestId: "00000000-0000-4000-8000-0000000000cc",
    origin: "",
    route: "nightly",
  };
}

async function setPolicy(patch: Partial<Policy>): Promise<void> {
  const policy: Policy = { ...DEFAULT_POLICY, denylist: [SENDER], autoTrash: true, ...patch };
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(policy))
    .run();
}

/** A trash suggestion from an Always OK to trash sender with no cap, old enough to act on. */
const trusted = (o: SeedSuggestionOptions = {}): SeedSuggestionOptions => ({
  action: "delete",
  segment: "rule",
  ceiling: "delete",
  receivedAt: SEED_NOW - 10 * DAY,
  confidence: 0.6,
  ...o,
});

async function rows(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .run<Record<string, unknown>>()
  ).results;
}

const status = async (id: number | undefined) => (await getSuggestionRow(id ?? 0))?.["status"];

describe("executeAutoTrash (contracts 12.11)", () => {
  beforeEach(() => setPolicy({}));

  it("trashes trusted mail through the owner path as an undoable auto_trash batch, without learning", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 3, trusted());
    const fake = new FakeProvider();
    const out = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });

    expect(out.response).toMatchObject({ executed: 3, failed: 0, retryLater: 0 });
    expect(out.scanned).toBe(3);
    expect(out.lastId).toBe(ids[2]);
    expect(fake.calls.map((c) => [c.method, c.ids.length])).toEqual([["trash", 3]]);
    const s = await getSuggestionRow(ids[0] ?? 0);
    expect(s).toMatchObject({
      status: "executed",
      final_action: "delete",
      decided_via: "cleanup",
      batch_id: out.response.batchId,
      label_id: null,
    });
    const batch = await rows(
      "SELECT kind, executed_count, undo_expires_at FROM action_batches WHERE id = ?1",
      out.response.batchId,
    );
    expect(batch[0]).toEqual({ kind: "auto_trash", executed_count: 3, undo_expires_at: SEED_NOW + DAY });
    const audit = await rows(
      "SELECT kind, count, result_json FROM audit_log WHERE batch_id = ?1",
      out.response.batchId,
    );
    expect(audit[0]).toMatchObject({ kind: "auto_trash", count: 3 });
    expect(JSON.parse(String(audit[0]?.["result_json"]))).toMatchObject({
      executed: 3,
      delete: 3,
      groups: 1,
    });
    // Calibration, priors and rule offers learn only from owner decisions.
    expect(await rows("SELECT id FROM labels WHERE account_id = ?1", acc.id)).toEqual([]);
    expect(await rows("SELECT key FROM sender_priors WHERE account_id = ?1", acc.id)).toEqual([]);
  });

  it("never touches a suggestion that a hard cap or the rule scope excludes", async () => {
    const acc = await seedAccount();
    const excluded = [
      ...(await seedSuggestions(acc.id, 1, trusted({ signals: { starred: true } }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ signals: { providerImportant: true } }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ signals: { ownerReplied: true } }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ signals: { isCorrespondent: true } }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ signals: { hasAttachments: true } }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ subject: "Your receipt for order 42" }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ receivedAt: SEED_NOW - DAY }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ segment: "sender" }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ ceiling: "archive" }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ action: "archive" }))),
      ...(await seedSuggestions(acc.id, 1, trusted({ action: "keep" }))),
      ...(await seedSuggestions(
        acc.id,
        1,
        trusted({ sender: "friend@other.example.org", senderDomain: "example.org" }),
      )),
    ];
    const [ok] = await seedSuggestions(acc.id, 1, trusted());
    const fake = new FakeProvider();
    const out = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });

    expect(out.response.executed).toBe(1);
    expect(out.response.results.map((r) => r.id)).toEqual([ok]);
    expect(fake.calls.flatMap((c) => c.ids)).toHaveLength(1);
    for (const id of excluded) expect(await status(id)).toBe("pending");
  });

  it("re-checks the current rules: a sender removed from Always OK to trash is left alone", async () => {
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, trusted());
    await setPolicy({ denylist: [] });
    const fake = new FakeProvider();
    const out = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });
    expect(out.response.executed).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(await status(id)).toBe("pending");
  });

  it("does nothing while the toggle is off (the default)", async () => {
    await setPolicy({ autoTrash: false });
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, trusted());
    const fake = new FakeProvider();
    const out = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });
    expect(out.response).toMatchObject({ batchId: null, executed: 0 });
    expect(fake.calls).toEqual([]);
    expect(await status(id)).toBe("pending");
  });

  it("stops at once when the toggle is turned off between the read and the claim", async () => {
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, trusted());
    let claimPrepared = false;
    const db = {
      prepare(sql: string) {
        if (/SET status = 'approved'/.test(sql)) claimPrepared = true;
        return env.DB.prepare(sql);
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (claimPrepared) {
          claimPrepared = false;
          await setPolicy({ autoTrash: false });
        }
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;
    const fake = new FakeProvider();
    const out = await executeAutoTrash(context(fake, db), { accountId: acc.id, limit: 100, afterId: 0 });
    expect(out.response.executed).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(await status(id)).toBe("pending");
  });

  it("skips paused and inactive accounts", async () => {
    const paused = await seedAccount({ paused: true });
    const reauth = await seedAccount({ status: "needs_reauth" });
    const [p] = await seedSuggestions(paused.id, 1, trusted());
    const [r] = await seedSuggestions(reauth.id, 1, trusted());
    const fake = new FakeProvider();
    for (const accountId of [paused.id, reauth.id]) {
      const out = await executeAutoTrash(context(fake), { accountId, limit: 100, afterId: 0 });
      expect(out.response.executed).toBe(0);
    }
    expect(fake.calls).toEqual([]);
    expect([await status(p), await status(r)]).toEqual(["pending", "pending"]);
  });

  it("pages by message id and honors the limit", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 3, trusted());
    const fake = new FakeProvider();
    const first = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 2, afterId: 0 });
    expect(first).toMatchObject({ scanned: 2, lastId: ids[1] });
    const second = await executeAutoTrash(context(fake), {
      accountId: acc.id,
      limit: 2,
      afterId: first.lastId ?? 0,
    });
    expect(second).toMatchObject({ scanned: 1, lastId: ids[2] });
    expect(second.response.results.map((r) => r.id)).toEqual([ids[2]]);
  });

  it("puts items back on a transient failure and makes exactly one provider call", async () => {
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, trusted());
    const fake = new FakeProvider({
      failWith: { trash: new ProviderRateLimitError({ provider: "gmail", retryAfterMs: 1000 }) },
    });
    const out = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });
    expect(out.response).toMatchObject({ executed: 0, retryLater: 1, batchId: null });
    expect(fake.calls).toHaveLength(1);
    expect(await status(id)).toBe("pending");
  });
});

describe("undo of an auto-trash batch (contracts 12.11)", () => {
  beforeEach(() => setPolicy({}));

  it("restores every email and leaves priors and labels untouched", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2, trusted());
    const fake = new FakeProvider();
    const { response } = await executeAutoTrash(context(fake), { accountId: acc.id, limit: 100, afterId: 0 });
    const res = await undoBatch(context(fake), response.batchId ?? 0);
    expect(res).toMatchObject({ restored: 2, failed: 0 });
    for (const id of ids) expect(await status(id)).toBe("undone");
    expect(await rows("SELECT key FROM sender_priors WHERE account_id = ?1", acc.id)).toEqual([]);
    expect(await rows("SELECT id FROM labels WHERE account_id = ?1", acc.id)).toEqual([]);
    const undo = await rows(
      "SELECT count FROM audit_log WHERE kind = 'undo' AND batch_id = ?1",
      response.batchId,
    );
    expect(undo).toEqual([{ count: 2 }]);
  });
});
