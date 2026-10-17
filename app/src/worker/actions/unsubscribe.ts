import { checkUnsubscribeUrl, ClearboxError, oneClickTarget } from "@clearbox/core";
import type { FetchLike } from "@clearbox/core";
import type { UnsubscribeErrorCode, UnsubscribeResponse } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { listAccounts } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { budgetDeltaStmt, readBudget } from "../db/budget.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, sumRowsRead, sumRowsWritten, toIso, utcDate } from "../db/sql.ts";
import { newestPendingFromSenderQuery, oneClickOffered, recordUnsubscribeStmt } from "../db/unsubscribes.ts";
import type { NewestPendingRow } from "../db/unsubscribes.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { tokenUpdateStmt } from "../scan/token-source.ts";
import {
  accountFailureStatements,
  assertOwnerBudget,
  classifyProviderError,
  openProvider,
} from "./execute.ts";
import type { AccountFailure, ActionContext } from "./execute.ts";

/** Total time allowed for the sender's server to answer the one-click POST. */
export const UNSUBSCRIBE_TIMEOUT_MS = 5_000;
/** RFC 8058 section 3.2: the List-Unsubscribe-Post key/value pair is the whole body. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

export type OneClickResult =
  | { ok: true; status: number }
  | {
      ok: false;
      error: Extract<
        UnsubscribeErrorCode,
        "sender_rejected" | "sender_redirect" | "sender_timeout" | "sender_unreachable"
      >;
      status: number | null;
    };

/**
 * The RFC 8058 POST. No cookies, credentials or other context (Workers fetch has no cookie jar and nothing is
 * added here), redirects are not followed (RFC 8058 forbids them), and the response body is cancelled unread,
 * so its size never matters. The URL must already have passed checkUnsubscribeUrl.
 */
export async function postOneClick(
  fetch: FetchLike,
  url: string,
  timeoutMs: number = UNSUBSCRIBE_TIMEOUT_MS,
): Promise<OneClickResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ONE_CLICK_BODY,
      redirect: "manual",
      signal: controller.signal,
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    if (res.status >= 300 && res.status < 400)
      return { ok: false, error: "sender_redirect", status: res.status };
    return { ok: false, error: "sender_rejected", status: res.status };
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? "sender_timeout" : "sender_unreachable",
      status: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface Attempt {
  error: UnsubscribeErrorCode | null;
  status: number | null;
  providerCalls: number;
  failure: AccountFailure | null;
  tokenStmt: D1PreparedStatement | null;
}

/**
 * Contracts 12.8: owner-initiated one-click unsubscribe from the sender of one group. Reads the List-Unsubscribe
 * headers of the sender's newest pending email from the provider (nothing is stored at ingest), checks the URL,
 * POSTs once and records the sender on success. Never retried automatically.
 */
export async function unsubscribeSender(
  ctx: ActionContext,
  accountId: string,
  sender: string,
): Promise<UnsubscribeResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const started = Date.now();
  const [budget, settings, visible] = await Promise.all([
    readBudget(db, utcDate(now)),
    readSettings(db),
    listAccounts(db, { includeDisconnected: false }),
  ]);
  assertOwnerBudget(budget, ctx.config, now);
  const account = visible.find((a) => a.id === accountId);
  if (!account) throw new ApiError(404, "not_found", "Group not found");

  const reads = await db.batch<NewestPendingRow>([
    bindQuery(db, newestPendingFromSenderQuery(accountId, sender)),
  ]);
  const newest = reads[0]?.results[0];
  const attempt: Attempt = { error: null, status: null, providerCalls: 0, failure: null, tokenStmt: null };

  if (!newest || !oneClickOffered(newest.signals_json)) attempt.error = "not_available";
  else if (account.status !== "active") attempt.error = "account_inactive";
  else {
    const encKey = await importEncKey(ctx.config.tokenEncKey);
    const { provider, tokens } = openProvider(ctx, account, encKey);
    let headers: Awaited<ReturnType<typeof provider.unsubscribeHeaders>> = null;
    try {
      attempt.providerCalls += 1;
      headers = await provider.unsubscribeHeaders(newest.provider_msg_id);
      if (headers === null) attempt.error = "message_gone";
    } catch (err) {
      const failure = classifyProviderError(err);
      attempt.error = failure.code === "unknown" ? "provider_error" : (failure.code as UnsubscribeErrorCode);
      if (failure.authError) attempt.failure = { account, error: failure.authError };
      logEvent("provider.error", {
        requestId: ctx.requestId,
        accountId: account.id,
        provider: account.provider,
        errorCode: err instanceof ClearboxError ? err.code : "unknown",
        status: null,
      });
      if (!(err instanceof ClearboxError)) {
        logEvent("request.error", {
          requestId: ctx.requestId,
          route: ctx.route,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      }
    }
    if (tokens.update) attempt.tokenStmt = await tokenUpdateStmt(db, account, encKey, tokens.update, now);
    if (headers !== null && attempt.error === null) {
      const target = oneClickTarget(headers.listUnsubscribe, headers.listUnsubscribePost);
      const checked =
        target === null ? null : checkUnsubscribeUrl(target, { ownHost: new URL(ctx.origin).hostname });
      if (checked === null) attempt.error = "not_available";
      else if (!checked.ok) attempt.error = "unsafe_url";
      else {
        const posted = await postOneClick(deps.fetch, checked.url);
        attempt.status = posted.status;
        if (!posted.ok) attempt.error = posted.error;
      }
    }
  }

  const ok = attempt.error === null;
  const stmts: D1PreparedStatement[] = [];
  if (ok) stmts.push(recordUnsubscribeStmt(db, accountId, sender, now));
  if (attempt.failure) stmts.push(...accountFailureStatements(db, [attempt.failure], settings.issues, now));
  if (attempt.tokenStmt) stmts.push(attempt.tokenStmt);
  stmts.push(
    auditStmt(db, {
      ts: now,
      accountId,
      kind: "unsubscribe",
      batchId: null,
      count: ok ? 1 : 0,
      result: { outcome: attempt.error ?? "unsubscribed", status: attempt.status ?? 0 },
    }),
  );
  const writes = await db.batch(stmts);
  await budgetDeltaStmt(
    db,
    utcDate(now),
    {
      rowsWritten: sumRowsWritten(writes) + 1,
      rowsRead: sumRowsRead([...reads, ...writes]),
      providerCalls: attempt.providerCalls,
    },
    now,
  ).run();

  logEvent("unsubscribe.done", {
    requestId: ctx.requestId,
    accountId,
    outcome: attempt.error ?? "unsubscribed",
    status: attempt.status,
    durationMs: Date.now() - started,
  });
  return {
    outcome: ok ? "unsubscribed" : "failed",
    error: attempt.error,
    unsubscribedAt: ok ? toIso(now) : null,
  };
}
