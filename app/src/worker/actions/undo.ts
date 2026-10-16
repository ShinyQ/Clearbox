import { ClearboxError } from "@clearbox/core";
import type { ActionKind, RestoreItem } from "@clearbox/core";
import type { ItemErrorCode, UndoItemResult, UndoResponse } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { listAccounts } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { claimUndoStmt, getBatch, resetUndoStmt } from "../db/batches.ts";
import { budgetDeltaStmt, readBudget } from "../db/budget.ts";
import { undoLabelStmt } from "../db/labels.ts";
import { updateProviderMsgIdStmt } from "../db/messages.ts";
import { priorStatements } from "../db/priors.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, chunk, MAX_BOUND_PARAMS, sumRowsRead, sumRowsWritten, utcDate } from "../db/sql.ts";
import { markUndoneQuery, undoTargetsQuery } from "../db/suggestions.ts";
import type { TargetRow } from "../db/suggestions.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { tokenUpdateStmt } from "../scan/token-source.ts";
import {
  accountFailureStatements,
  assertOwnerBudget,
  classifyProviderError,
  mapActionError,
  openProvider,
} from "./execute.ts";
import type { AccountFailure, ActionContext } from "./execute.ts";
import { undoPriorDeltas } from "./learn.ts";

interface Restored {
  row: TargetRow;
  account: Account;
  finalAction: ActionKind;
  newId: string;
}

/** Accounts per undo; leaves room in each undoTargetsQuery for the batch id and some message ids. */
const MAX_UNDO_ACCOUNTS = 90;

async function selectUndoTargets(
  db: D1Database,
  accountIds: readonly string[],
  batchId: number,
  ids: readonly number[],
): Promise<TargetRow[]> {
  if (accountIds.length === 0 || ids.length === 0) return [];
  if (accountIds.length > MAX_UNDO_ACCOUNTS) throw new ClearboxError("too_many_accounts");
  // Each statement binds accounts + batch id + ids (at most MAX_BOUND_PARAMS).
  const queries = chunk(ids, MAX_BOUND_PARAMS - accountIds.length - 1).map((part) =>
    bindQuery(db, undoTargetsQuery(accountIds, batchId, part)),
  );
  return (await db.batch<TargetRow>(queries)).flatMap((r) => r.results);
}

/** Contracts 7.8 plus decisions 10 and 11. */
export async function undoBatch(ctx: ActionContext, batchId: number): Promise<UndoResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const batch = await getBatch(db, batchId);
  if (!batch) throw new ApiError(404, "not_found", "Batch not found");
  if (now >= batch.undoExpiresAt)
    throw new ApiError(410, "undo_expired", "The undo window for this batch has ended");
  const [budget, settings, accounts] = await Promise.all([
    readBudget(db, utcDate(now)),
    readSettings(db),
    listAccounts(db, { includeDisconnected: true }),
  ]);
  assertOwnerBudget(budget, ctx.config, now);

  const claim = await claimUndoStmt(db, batchId, now).run<{ id: number }>();
  if (claim.results.length === 0) {
    return {
      batchId,
      results: batch.suggestionIds.map((id) => ({ id, outcome: "skipped", error: null })),
      restored: 0,
      failed: 0,
      skipped: batch.suggestionIds.length,
    };
  }
  const writes: D1Result[] = [claim];
  let committed = false;

  try {
    const byAccount = new Map(accounts.map((a) => [a.id, a]));
    const rows = await selectUndoTargets(db, [...byAccount.keys()], batchId, batch.suggestionIds);
    const rowById = new Map(rows.map((r) => [r.message_id, r]));
    const results = new Map<number, UndoItemResult>();
    const set = (id: number, outcome: UndoItemResult["outcome"], error: ItemErrorCode | null) =>
      results.set(id, { id, outcome, error });

    // 1. Classify: keep and anything no longer executed is skipped (decision 11).
    const work = new Map<string, TargetRow[]>();
    for (const id of batch.suggestionIds) {
      const row = rowById.get(id);
      if (!row || row.status !== "executed" || row.final_action === null || row.final_action === "keep") {
        set(id, "skipped", null);
        continue;
      }
      const account = byAccount.get(row.account_id);
      if (!account || account.status !== "active") {
        set(id, "failed", "account_inactive");
        continue;
      }
      work.set(account.id, [...(work.get(account.id) ?? []), row]);
    }

    // 2. One restore call per account, sequential.
    const restored: Restored[] = [];
    const failures: AccountFailure[] = [];
    const tokenStmts: D1PreparedStatement[] = [];
    let providerCalls = 0;
    const encKey = await importEncKey(ctx.config.tokenEncKey);
    for (const [accountId, items] of work) {
      const account = byAccount.get(accountId);
      if (!account) continue;
      const { provider, tokens } = openProvider(ctx, account, encKey);
      const restoreItems: RestoreItem[] = items.map((r) => ({
        id: r.provider_msg_id,
        from: r.final_action === "delete" ? "trash" : "archive",
      }));
      try {
        providerCalls += 1;
        const res = await provider.restore(restoreItems);
        const byPid = new Map(res.map((r) => [r.id, r]));
        for (const row of items) {
          const r = byPid.get(row.provider_msg_id);
          if (!r) set(row.message_id, "failed", "unknown");
          else if (r.ok) {
            restored.push({ row, account, finalAction: row.final_action ?? "keep", newId: r.newId });
            set(row.message_id, "restored", null);
          } else set(row.message_id, "failed", mapActionError(r.error));
        }
      } catch (err) {
        const failure = classifyProviderError(err);
        if (failure.authError) failures.push({ account, error: failure.authError });
        for (const row of items) set(row.message_id, "failed", failure.code);
        logEvent("provider.error", {
          requestId: ctx.requestId,
          accountId,
          provider: account.provider,
          errorCode: err instanceof ClearboxError ? err.code : "unknown",
          status: null,
        });
        // Not a provider error class: surface the class name (never the message) like onApiError does.
        if (!(err instanceof ClearboxError)) {
          logEvent("request.error", {
            requestId: ctx.requestId,
            route: ctx.route,
            errorName: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      if (tokens.update) tokenStmts.push(await tokenUpdateStmt(db, account, encKey, tokens.update, now));
    }

    const list = batch.suggestionIds.map(
      (id) => results.get(id) ?? { id, outcome: "skipped" as const, error: null },
    );
    const count = (o: UndoItemResult["outcome"]) => list.filter((r) => r.outcome === o).length;

    // 3. One D1 batch (one transaction) with every result.
    const stmts: D1PreparedStatement[] = [];
    for (const r of restored) {
      stmts.push(bindQuery(db, markUndoneQuery(r.account.id, r.row.message_id, now)));
      if (r.row.label_id !== null) stmts.push(undoLabelStmt(db, r.account.id, r.row.label_id, now));
      if (r.newId !== r.row.provider_msg_id)
        stmts.push(updateProviderMsgIdStmt(db, r.account.id, r.row.message_id, r.newId));
    }
    stmts.push(
      ...priorStatements(
        db,
        undoPriorDeltas(
          restored.map((r) => ({
            accountId: r.account.id,
            sender: r.row.sender,
            senderDomain: r.row.sender_domain,
            finalAction: r.finalAction,
          })),
        ),
        now,
      ),
    );
    stmts.push(...accountFailureStatements(db, failures, settings.issues, now));
    stmts.push(...tokenStmts);
    const touched = new Set(restored.map((r) => r.account.id));
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: touched.size === 1 ? ([...touched][0] ?? null) : null,
        kind: "undo",
        batchId,
        count: restored.length,
        result: { restored: count("restored"), failed: count("failed") },
      }),
    );
    // Decision 10: reopen only when nothing was restored and something failed, so the owner can retry.
    // An all-skipped batch (for example keep-only) has nothing to retry and stays undone.
    if (restored.length === 0 && count("failed") > 0) stmts.push(resetUndoStmt(db, batchId, now));
    writes.push(...(await db.batch(stmts)));
    committed = true;

    // 4. Budget (contracts 8.5: counted like a tick's D1 call 4).
    await budgetDeltaStmt(
      db,
      utcDate(now),
      { rowsWritten: sumRowsWritten(writes) + 1, rowsRead: sumRowsRead(writes), providerCalls },
      now,
    ).run();

    const response: UndoResponse = {
      batchId,
      results: list,
      restored: count("restored"),
      failed: count("failed"),
      skipped: count("skipped"),
    };
    logEvent("undo.done", {
      requestId: ctx.requestId,
      batchId,
      restored: response.restored,
      failed: response.failed,
      skipped: response.skipped,
    });
    return response;
  } catch (err) {
    // Reopen only while nothing was written; after the commit a reset could apply priors twice.
    if (!committed) {
      await resetUndoStmt(db, batchId, now)
        .run()
        .catch(() => undefined);
    }
    throw err;
  }
}
