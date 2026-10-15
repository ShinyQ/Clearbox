import {
  DEFAULT_POLICY,
  DELETE_MARGIN,
  FakeEngine,
  MIN_CONFIDENCE,
  POLL_INTERVAL_MS,
  createSubrequestCounter,
} from "@clearbox/core";
import type { DecisionError, MailMessage } from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decideStage,
  emptyContext,
  finalize,
  identify,
  prepareFresh,
} from "../../../src/worker/scan/ingest.ts";
import type { IngestSettings } from "../../../src/worker/scan/ingest.ts";
import { encryptTokenUpdate } from "../../../src/worker/scan/tick-tokens.ts";
import {
  applyIssues,
  auditStmt,
  budgetUpsertStmt,
  buildSuccessWrite,
  computeAdvance,
  utcDate,
} from "../../../src/worker/scan/write-plan.ts";
import type { AccountCursorState, Stmt, SuccessWriteInput } from "../../../src/worker/scan/write-plan.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { testEncKey } from "../helpers/seed.ts";
import {
  ACCOUNT_A,
  DAY,
  MINUTE,
  NOW,
  OWNER,
  count,
  decryptAccountToken,
  getAccount,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

const S: IngestSettings = {
  policy: DEFAULT_POLICY,
  thresholds: { tauDelete: 0.8, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
  ownerAddresses: [OWNER],
  now: NOW,
  accountId: ACCOUNT_A,
};

const CUR: AccountCursorState = {
  phase: "inbox_backfill",
  backfill_done: 0,
  sent_cursor: null,
  sent_scanned: 0,
  backfill_cursor: "b-1",
  incremental_cursor: "i-1",
  last_incremental_at: NOW - MINUTE,
  watermark_received_at: NOW - 9 * DAY,
};

function m(id: string, from: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return makeMailMessage({
    providerMessageId: id,
    threadId: `t-${id}`,
    receivedAt: NOW - 10 * DAY,
    from: { address: from, name: null },
    to: [OWNER],
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    isRead: false,
    ...overrides,
  });
}

async function finals(messages: MailMessage[], overrides = new Map<string, DecisionError>()) {
  const { items } = prepareFresh(messages, identify(messages, S), emptyContext(), [], S);
  return finalize(
    await decideStage(new FakeEngine({ overrides }), items, createSubrequestCounter(45)),
    S.thresholds,
    NOW,
  );
}

async function exec(stmts: Stmt[]) {
  return env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
}

function input(overrides: Partial<SuccessWriteInput>): SuccessWriteInput {
  return {
    accountId: ACCOUNT_A,
    tickId: "tick-1",
    now: NOW,
    policyVersion: 1,
    storeSnippets: true,
    items: [],
    sent: [],
    ownerAddresses: [OWNER],
    removedIds: [],
    issues: null,
    tokens: null,
    maxPageSize: 25,
    inboxEstimate: null,
    advance: computeAdvance(CUR, { kind: "redecide" }, null, NOW),
    ...overrides,
  };
}

describe("computeAdvance", () => {
  it("follows the contracts 8.3 phase table", () => {
    const sent = { ...CUR, phase: "sent_backfill" as const };
    expect(
      computeAdvance(sent, { kind: "sent_backfill", itemCount: 100, nextCursor: "s-2" }, null, NOW),
    ).toMatchObject({
      phase: "sent_backfill",
      sent_cursor: "s-2",
      sent_scanned: 100,
      nextTickAt: NOW,
    });
    expect(
      computeAdvance(
        { ...sent, sent_scanned: 900 },
        { kind: "sent_backfill", itemCount: 100, nextCursor: "s-2" },
        null,
        NOW,
      ).phase,
    ).toBe("inbox_backfill");
    expect(
      computeAdvance(sent, { kind: "sent_backfill", itemCount: 3, nextCursor: null }, null, NOW).phase,
    ).toBe("inbox_backfill");
    expect(
      computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: "b-2", partial: false }, NOW - DAY, NOW),
    ).toMatchObject({
      phase: "inbox_backfill",
      backfill_cursor: "b-2",
      watermark_received_at: NOW - DAY,
      nextTickAt: NOW,
    });
    expect(
      computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: null, partial: false }, null, NOW),
    ).toMatchObject({ phase: "incremental", backfill_done: 1, backfill_cursor: null });
    expect(
      computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: null, partial: true }, null, NOW),
    ).toMatchObject({ phase: "inbox_backfill", backfill_cursor: "b-1", nextTickAt: NOW });
    expect(
      computeAdvance(
        CUR,
        { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false },
        null,
        NOW,
      ),
    ).toMatchObject({
      phase: "inbox_backfill",
      incremental_cursor: "i-2",
      last_incremental_at: NOW,
      nextTickAt: NOW,
    });
    const inc = { ...CUR, phase: "incremental" as const };
    expect(
      computeAdvance(
        inc,
        { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: false, partial: false },
        null,
        NOW,
      ).nextTickAt,
    ).toBe(NOW);
    expect(
      computeAdvance(
        inc,
        { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false },
        null,
        NOW,
      ).nextTickAt,
    ).toBe(NOW + POLL_INTERVAL_MS);
    expect(
      computeAdvance(
        inc,
        { kind: "incremental", startCursor: "r-1", nextCursor: "i-2", caughtUp: true, partial: true },
        null,
        NOW,
      ),
    ).toMatchObject({ incremental_cursor: "r-1", nextTickAt: NOW });
    expect(computeAdvance(inc, { kind: "redecide" }, null, NOW)).toMatchObject({
      phase: "incremental",
      nextTickAt: NOW,
    });
  });
});

describe("applyIssues", () => {
  it("raises, clears and reports a change only when the set changes", () => {
    const first = applyIssues([], [{ code: "storage_near_limit", accountId: null }], [], NOW);
    expect(first.changed).toBe(true);
    expect(first.issues).toEqual([
      { code: "storage_near_limit", since: new Date(NOW).toISOString(), accountId: null },
    ]);
    expect(
      applyIssues(
        first.issues,
        [{ code: "storage_near_limit", accountId: null }],
        ["decision_auth_failed"],
        NOW + 1,
      ).changed,
    ).toBe(false);
    expect(applyIssues(first.issues, [], ["storage_near_limit"], NOW)).toMatchObject({
      changed: true,
      issues: [],
      cleared: ["storage_near_limit"],
    });
  });
});

describe("auditStmt", () => {
  it("stores counts and codes only", async () => {
    await resetDb();
    await seedTickAccount();
    await exec([auditStmt(NOW, ACCOUNT_A, "reauth_required", 0, { reason: "token_revoked" })]);
    expect(
      await one("SELECT kind, count, result_json FROM audit_log WHERE account_id = ?1", ACCOUNT_A),
    ).toEqual({
      kind: "reauth_required",
      count: 0,
      result_json: '{"reason":"token_revoked"}',
    });
  });
});

describe("buildSuccessWrite", () => {
  beforeEach(resetDb);

  it("writes rows, dismissals, cursor and tokens, releases the lease, and replayed inserts are no-ops", async () => {
    await seedTickAccount({ phase: "incremental" });
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'tick-1', ?3, ?4)",
    )
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE)
      .run();
    const gone = await seedMessage(ACCOUNT_A, { providerId: "gone" });
    const items = await finals(
      [
        m("a", "news@shop.example"),
        m("b", "news@shop.example", { isRead: true }),
        m("c", "deals@other.example"),
      ],
      new Map([["c", decisionError("server", 503, true, "item")]]),
    );
    const advance = computeAdvance(
      { ...CUR, phase: "incremental" },
      { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false },
      NOW - 10 * DAY,
      NOW,
    );
    const tokens = await encryptTokenUpdate(
      await testEncKey(),
      { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-9", accessExpiresAt: NOW + 3_600_000, refreshToken: "r-9" },
    );
    const write = buildSuccessWrite(
      input({
        items,
        advance,
        tokens,
        storeSnippets: false,
        removedIds: ["gone"],
        inboxEstimate: 1234,
        sent: [{ threadId: "t-x", recipients: ["friend@example.net", OWNER], sentAt: NOW - DAY }],
      }),
    );
    const res = await exec(write.stmts);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(4);
    expect(await count("suggestions", "status = 'pending'")).toBe(2);
    expect(
      await count(
        "suggestions",
        "status = 'awaiting_model' AND retry_after = ?1 AND decision_attempts = 1",
        NOW + 5 * MINUTE,
      ),
    ).toBe(1);
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", gone)).toEqual({
      status: "dismissed",
    });
    expect(write.dismissals.reduce((n, i) => n + (res[i]?.meta.changes ?? 0), 0)).toBe(1);
    expect(
      await one(
        "SELECT seen_count, read_count FROM senders WHERE account_id = ?1 AND address = 'news@shop.example'",
        ACCOUNT_A,
      ),
    ).toEqual({ seen_count: 2, read_count: 1 });
    expect(await count("correspondents", "address = 'friend@example.net'")).toBe(1);
    expect(await count("correspondents", "address = ?1", OWNER)).toBe(0);
    expect(await count("sent_threads", "thread_id = 't-x'")).toBe(1);
    expect(await one("SELECT snippet FROM messages WHERE provider_msg_id = 'a'")).toEqual({ snippet: null });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      incremental_cursor: "i-2",
      last_incremental_at: NOW,
      messages_ingested: 3,
      attempts: 0,
      last_tick_at: NOW,
      next_tick_at: NOW + 5 * MINUTE,
      inbox_estimate: 1234,
    });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("r-9");
    expect(await one("SELECT released_at FROM leases WHERE holder = 'tick-1'")).toEqual({ released_at: NOW });
    expect(res[write.nextTickIndex]?.results[0]).toEqual({ next_tick_at: NOW + 5 * MINUTE });

    await exec(write.stmts.slice(0, 6));
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(4);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(4);
  });

  it("dismisses an awaiting_model suggestion via removedIds without aborting the batch", async () => {
    await seedTickAccount({ phase: "incremental" });
    const awaiting = await seedMessage(ACCOUNT_A, {
      providerId: "wait",
      status: "awaiting_model",
      retryAfter: NOW + MINUTE,
    });
    const pending = await seedMessage(ACCOUNT_A, { providerId: "pend" });
    const write = buildSuccessWrite(input({ removedIds: ["wait", "pend", "unknown"] }));
    const res = await exec(write.stmts);
    expect(
      await one("SELECT status, action, expires_at FROM suggestions WHERE message_id = ?1", awaiting),
    ).toEqual({ status: "dismissed", action: "unsure", expires_at: NOW + 30 * DAY });
    expect(await one("SELECT status, action FROM suggestions WHERE message_id = ?1", pending)).toEqual({
      status: "dismissed",
      action: "delete",
    });
    expect(write.dismissals.reduce((n, i) => n + (res[i]?.meta.changes ?? 0), 0)).toBe(2);
  });

  it("emits no dismissal statement and no empty IN list for empty id lists", () => {
    const write = buildSuccessWrite(input({}));
    expect(write.dismissals).toEqual([]);
    for (const s of write.stmts) expect(s.sql).not.toMatch(/IN \(\s*\)/);
    expect(write.stmts.some((s) => s.sql.includes("'dismissed'"))).toBe(false);
  });

  it("chunks a long removedIds list under the bound parameter limit", async () => {
    await seedTickAccount({ phase: "incremental" });
    const ids = Array.from({ length: 200 }, (_, i) => `r-${i}`);
    const write = buildSuccessWrite(input({ removedIds: ids }));
    expect(write.dismissals).toHaveLength(3);
    for (const s of write.stmts) expect(s.params.length).toBeLessThanOrEqual(99);
    await exec(write.stmts);
  });

  it("updates an awaiting_model suggestion when its message is re-decided", async () => {
    await seedTickAccount({ phase: "incremental" });
    const first = await finals(
      [m("c", "deals@other.example")],
      new Map([["c", decisionError("server", 503, true, "item")]]),
    );
    await exec(buildSuccessWrite(input({ items: first })).stmts);
    const id = (await one<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = 'c'"))?.id ?? 0;
    expect(await count("suggestions", "message_id = ?1 AND status = 'awaiting_model'", id)).toBe(1);
    const [again] = await finals([m("c", "deals@other.example")]);
    const redecided = { ...again!, existingMessageId: id, attempts: 2 };
    await exec(buildSuccessWrite(input({ items: [redecided], now: NOW + MINUTE })).stmts);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(1);
    expect(
      await one("SELECT status, decision_attempts, retry_after FROM suggestions WHERE message_id = ?1", id),
    ).toEqual({ status: "pending", decision_attempts: 2, retry_after: null });
  });

  it("never writes tokens back to a disconnected account", async () => {
    await seedTickAccount({ status: "disconnected" });
    const tokens = await encryptTokenUpdate(
      await testEncKey(),
      { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-9", accessExpiresAt: NOW, refreshToken: "r-9" },
    );
    await exec(buildSuccessWrite(input({ tokens })).stmts);
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBeNull();
  });

  it("budgetUpsertStmt accumulates counters per UTC day and keeps the last known size", async () => {
    const d = {
      date: utcDate(NOW),
      rowsWritten: 10,
      rowsRead: 5,
      ticks: 1,
      messagesIngested: 3,
      decisionCalls: 3,
      decisionFailures: 1,
      decisionInputTokens: 900,
      providerCalls: 2,
      dbSizeBytes: 1000,
      now: NOW,
    };
    await exec([budgetUpsertStmt(d)]);
    await exec([budgetUpsertStmt({ ...d, dbSizeBytes: 0 })]);
    expect(
      await one(
        "SELECT rows_written, ticks, decision_failures, db_size_bytes FROM budget WHERE date = ?1",
        d.date,
      ),
    ).toEqual({ rows_written: 20, ticks: 2, decision_failures: 2, db_size_bytes: 1000 });
  });
});
