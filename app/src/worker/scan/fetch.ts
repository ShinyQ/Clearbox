import { CursorExpiredError, ProviderResponseError, SENT_PAGE_SIZE } from "@clearbox/core";
import type { ChangesPage, InboxPage, MailProvider, SentPage } from "@clearbox/core";
import type { TickKind } from "../../shared/api.ts";
import type { TickAccountRow } from "./claim.ts";
import { utcDate } from "./write-plan.ts";

/** Amendment A4: during backfill, refresh when unknown or on the first tick of a UTC day. */
export function shouldRefreshEstimate(a: TickAccountRow, kind: TickKind, now: number): boolean {
  if (kind !== "sent_backfill" && kind !== "inbox_backfill") return false;
  return a.inbox_estimate === null || a.last_tick_at === null || utcDate(a.last_tick_at) !== utcDate(now);
}

/** Best effort: any failure keeps the stored estimate. */
export async function fetchInboxEstimate(provider: MailProvider): Promise<number | null> {
  try {
    return await provider.inboxEstimate();
  } catch {
    return null;
  }
}

/**
 * An expired cursor, or a stored provider URL (Graph nextLink / deltaLink) that the provider refused to call
 * because it is not on the provider's origin (ProviderResponseError status 0, no request was sent).
 */
function isStaleCursor(err: unknown): boolean {
  return err instanceof CursorExpiredError || (err instanceof ProviderResponseError && err.status === 0);
}

export type Fetched =
  | { kind: "sent_backfill"; page: SentPage }
  | { kind: "inbox_backfill"; page: InboxPage }
  | { kind: "incremental"; page: ChangesPage; startCursor: string }
  | { kind: "redecide" };

/**
 * One provider page; sequential requests only (never Promise.all over provider calls: the token source has no
 * single-flight refresh). A stale cursor restarts the backfill or sent scan from the newest mail, or resyncs
 * the incremental cursor from the watermark; a second failure is rethrown, so it never loops.
 */
export async function fetchPage(
  kind: TickKind,
  provider: MailProvider,
  a: Pick<
    TickAccountRow,
    "sent_cursor" | "backfill_cursor" | "incremental_cursor" | "watermark_received_at" | "page_size"
  >,
): Promise<Fetched> {
  switch (kind) {
    case "sent_backfill":
      try {
        return { kind, page: await provider.listSentPage(a.sent_cursor, SENT_PAGE_SIZE) };
      } catch (err) {
        if (!isStaleCursor(err) || a.sent_cursor === null) throw err;
        return { kind, page: await provider.listSentPage(null, SENT_PAGE_SIZE) };
      }
    case "inbox_backfill":
      try {
        return { kind, page: await provider.listInboxPage(a.backfill_cursor, a.page_size) };
      } catch (err) {
        if (!isStaleCursor(err) || a.backfill_cursor === null) throw err;
        return { kind, page: await provider.listInboxPage(null, a.page_size) };
      }
    case "incremental":
      try {
        return {
          kind,
          page: await provider.syncChanges(a.incremental_cursor, a.page_size),
          startCursor: a.incremental_cursor,
        };
      } catch (err) {
        if (!isStaleCursor(err)) throw err;
        const cursor = await provider.resyncCursor(a.watermark_received_at);
        return { kind, page: await provider.syncChanges(cursor, a.page_size), startCursor: cursor };
      }
    case "redecide":
      return { kind };
  }
}
