import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  disconnectAccountStmt,
  findOpenAccountByEmail,
  getAccount,
  listAccounts,
  markAccountStatusStmt,
  setInboxEstimateStmt,
  setPausedStmt,
  toAccountView,
} from "../../../src/worker/db/accounts.ts";
import { claimUndoStmt, getBatch, insertBatchStmt, resetUndoStmt } from "../../../src/worker/db/batches.ts";
import { undoLabelStmt } from "../../../src/worker/db/labels.ts";
import { insertMessageStmt, updateProviderMsgIdStmt } from "../../../src/worker/db/messages.ts";
import { addPriorDelta, priorStatements } from "../../../src/worker/db/priors.ts";
import {
  countOpenByAccount,
  decodeGroupKey,
  dismissOpenStmt,
  encodeGroupKey,
} from "../../../src/worker/db/suggestions.ts";
import {
  getSuggestionRow,
  SEED_NOW,
  seedAccount,
  seedLabels,
  seedMessages,
  seedSuggestions,
} from "../helpers/seed.ts";

describe("accounts repository", () => {
  it("maps rows, hides disconnected accounts and finds by provider and email", async () => {
    const a = await seedAccount({ provider: "gmail", email: "one@example.com" });
    const b = await seedAccount({ provider: "outlook", email: "two@example.com", archiveFolderId: null });
    await seedAccount({ status: "disconnected" });
    expect(a.refreshToken?.iv.length).toBe(12);
    expect(a.grantedScopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    const visible = await listAccounts(env.DB, { includeDisconnected: false });
    expect(visible.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect((await listAccounts(env.DB, { includeDisconnected: true })).length).toBe(3);
    expect((await findOpenAccountByEmail(env.DB, "gmail", "one@example.com"))?.id).toBe(a.id);
    expect(await findOpenAccountByEmail(env.DB, "outlook", "one@example.com")).toBeNull();
    const view = toAccountView(b, { pending: 2, awaitingModel: 1 });
    expect(view).toMatchObject({
      id: b.id,
      provider: "outlook",
      status: "active",
      paused: false,
      archiveSupported: false,
      sync: {
        pendingCount: 2,
        awaitingModelCount: 1,
        nextTickAt: null,
        phase: "incremental",
        inboxEstimate: null,
      },
    });
  });

  it("pauses, marks status and disconnects (wiping tokens and dismissing open suggestions)", async () => {
    const a = await seedAccount();
    const [pending, awaiting, executed] = [
      ...(await seedSuggestions(a.id, 1)),
      ...(await seedSuggestions(a.id, 1, { status: "awaiting_model" })),
      ...(await seedSuggestions(a.id, 1, { status: "executed", finalAction: "delete" })),
    ];
    await setPausedStmt(env.DB, a.id, true, SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.paused).toBe(true);
    await setInboxEstimateStmt(env.DB, a.id, 12_345, SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.inboxEstimate).toBe(12_345);
    await markAccountStatusStmt(env.DB, a.id, "needs_reauth", "invalid_grant", SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.statusReason).toBe("invalid_grant");
    await env.DB.batch([
      disconnectAccountStmt(env.DB, a.id, SEED_NOW),
      dismissOpenStmt(env.DB, a.id, SEED_NOW),
    ]);
    const after = await getAccount(env.DB, a.id);
    expect(after).toMatchObject({
      status: "disconnected",
      refreshToken: null,
      accessToken: null,
      accessExpiresAt: null,
    });
    expect((await getSuggestionRow(pending ?? 0))?.["status"]).toBe("dismissed");
    expect(await getSuggestionRow(awaiting ?? 0)).toMatchObject({ status: "dismissed", action: "unsure" });
    expect((await getSuggestionRow(executed ?? 0))?.["status"]).toBe("executed");
  });
});

describe("messages and suggestions", () => {
  it("ignores duplicate provider ids and updates moved ids", async () => {
    const a = await seedAccount();
    const [id] = await seedMessages(a.id, 1, { providerMsgId: "dup-1" });
    const again = await insertMessageStmt(env.DB, a.id, {
      providerMsgId: "dup-1",
      threadId: null,
      internetMessageId: null,
      sender: "",
      senderName: null,
      senderDomain: "",
      subject: null,
      snippet: null,
      receivedAt: 0,
      isRead: false,
      signalsJson: "{}",
      webLink: null,
      createdAt: 0,
    }).run();
    expect(again.meta.changes).toBe(0);
    await updateProviderMsgIdStmt(env.DB, a.id, id ?? 0, "moved-1").run();
    const row = await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1").bind(id).first();
    expect(row).toEqual({ provider_msg_id: "moved-1" });
  });

  it("counts open suggestions per account", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await seedSuggestions(a.id, 3);
    await seedSuggestions(a.id, 2, { status: "awaiting_model" });
    await seedSuggestions(b.id, 1, { status: "executed", finalAction: "keep" });
    const counts = await countOpenByAccount(env.DB, [a.id, b.id]);
    expect(counts.get(a.id)).toEqual({ pending: 3, awaitingModel: 2 });
    expect(counts.get(b.id)).toEqual({ pending: 0, awaitingModel: 0 });
    expect((await countOpenByAccount(env.DB, [])).size).toBe(0);
  });

  it("encodes and decodes group keys", () => {
    const key = encodeGroupKey("acc_0000000000000001", "news@example.com", "delete");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGroupKey(key)).toEqual({
      accountId: "acc_0000000000000001",
      sender: "news@example.com",
      action: "delete",
    });
    expect(decodeGroupKey("garbage")).toBeNull();
    expect(
      decodeGroupKey(encodeGroupKey("acc_0000000000000001", "x@example.com", "delete").slice(0, -3)),
    ).toBeNull();
  });
});

describe("labels, priors and batches", () => {
  it("rewrites a label on undo", async () => {
    const a = await seedAccount();
    const [labelId] = await seedLabels(a.id, 1, { ownerAction: "delete" });
    await undoLabelStmt(env.DB, a.id, labelId ?? 0, SEED_NOW).run();
    const row = await env.DB.prepare("SELECT owner_action, source FROM labels WHERE id = ?1")
      .bind(labelId)
      .first();
    expect(row).toEqual({ owner_action: "keep", source: "undo" });
  });

  it("aggregates prior deltas per key and clamps at zero", async () => {
    const a = await seedAccount();
    const map = new Map();
    addPriorDelta(map, a.id, "news@example.com", "example.com", { deletes: 1, keeps: 0 });
    addPriorDelta(map, a.id, "news@example.com", "example.com", { deletes: 1, keeps: 0 });
    addPriorDelta(map, a.id, "", "example.com", { deletes: 0, keeps: 1 });
    await env.DB.batch(priorStatements(env.DB, map, SEED_NOW));
    const rows = await env.DB.prepare(
      "SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key",
    )
      .bind(a.id)
      .run();
    expect(rows.results).toEqual([
      { key: "@example.com", deletes: 2, keeps: 1 },
      { key: "news@example.com", deletes: 2, keeps: 0 },
    ]);
    const undo = new Map();
    addPriorDelta(undo, a.id, "news@example.com", "example.com", { deletes: -3, keeps: 1 });
    await env.DB.batch(priorStatements(env.DB, undo, SEED_NOW));
    const after = await env.DB.prepare(
      "SELECT deletes, keeps FROM sender_priors WHERE account_id = ?1 AND key = ?2",
    )
      .bind(a.id, "news@example.com")
      .first();
    expect(after).toEqual({ deletes: 0, keeps: 1 });
  });

  it("inserts a batch and claims undo once", async () => {
    const res = await insertBatchStmt(env.DB, {
      kind: "approve",
      suggestionIds: [1, 2],
      requestedCount: 2,
      executedCount: 2,
      failedCount: 0,
      createdAt: SEED_NOW,
      undoExpiresAt: SEED_NOW + 86_400_000,
    }).first<{ id: number }>();
    const id = res?.id ?? 0;
    expect(await getBatch(env.DB, id)).toMatchObject({
      kind: "approve",
      suggestionIds: [1, 2],
      undoneAt: null,
    });
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 1).run()).results).toHaveLength(1);
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 2).run()).results).toHaveLength(0);
    await resetUndoStmt(env.DB, id, SEED_NOW + 1).run();
    expect((await getBatch(env.DB, id))?.undoneAt).toBeNull();
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 86_400_001).run()).results).toHaveLength(0);
  });
});
