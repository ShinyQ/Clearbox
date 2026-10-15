import type { AccountView, Insights } from "../../shared/api.ts";
import type { AccountUiStatus, ProviderKind } from "./view-types.ts";

export function deriveAccountUiStatus(account: AccountView, now: number): AccountUiStatus {
  if (account.status === "config_error") return "config_error";
  if (account.status === "needs_reauth") return "needs_reauth";
  if (account.paused) return "paused";
  if (account.sync.backoffUntil && Date.parse(account.sync.backoffUntil) > now) return "waiting";
  if (account.sync.phase !== "incremental" || !account.sync.backfillDone) return "catching_up";
  return "up_to_date";
}

/** Share of the inbox sorted so far (A4, decision W20). Null when unknown or finished. */
export function catchUpFraction(account: Pick<AccountView, "sync">): number | null {
  const { inboxEstimate, messagesIngested, backfillDone } = account.sync;
  if (backfillDone || !inboxEstimate || inboxEstimate <= 0) return null;
  return Math.min(0.99, messagesIngested / inboxEstimate);
}

export function backlogRemaining(account: Pick<AccountView, "sync">): number | null {
  const { inboxEstimate, messagesIngested, backfillDone } = account.sync;
  if (backfillDone) return 0;
  if (!inboxEstimate) return null;
  return Math.max(0, inboxEstimate - messagesIngested);
}

/** Mean messagesIngested of the last 3 complete days (the last history entry is today). */
export function dailyRateFrom(history: Insights["history"]): number {
  const complete = history.slice(0, -1).slice(-3);
  if (complete.length === 0) return 6_800;
  const mean = complete.reduce((sum, d) => sum + d.messagesIngested, 0) / complete.length;
  return mean > 0 ? mean : 6_800;
}

export function etaText(remaining: number, dailyRate: number): string {
  const days = remaining / dailyRate;
  if (days < 0.5) return "less than a day";
  if (days < 1.5) return "about 1 day";
  return `about ${Math.ceil(days)} days`;
}

export const providerName = (p: ProviderKind): "Gmail" | "Outlook" => (p === "gmail" ? "Gmail" : "Outlook");

export function minutesUntil(iso: string, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** Newest lastTickAt among active accounts, for "Sorted 4 min ago". */
export function newestTickAt(accounts: readonly AccountView[]): string | null {
  const ticks = accounts
    .filter((a) => a.status === "active" && a.sync.lastTickAt)
    .map((a) => a.sync.lastTickAt as string)
    .sort();
  return ticks[ticks.length - 1] ?? null;
}
