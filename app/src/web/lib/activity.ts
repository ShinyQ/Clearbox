import type { AccountView, ActionBatchView, ActivityEntry } from "../../shared/api.ts";
import { isKeepOnly } from "./keep-only.ts";
import { unsubscribeActivityResult } from "./copy-unsubscribe.ts";
import { toPercent } from "./confidence.ts";
import { formatCount, plural } from "./format.ts";

export type ActivityLast =
  | { kind: "undo"; batchId: number }
  | { kind: "undone" }
  | { kind: "expired" }
  | { kind: "reconnect"; account: AccountView }
  | { kind: "route"; label: string; to: string }
  | null;

export interface ActivityRow {
  verb: string;
  detail: string;
  result: string;
  account: string;
  last: ActivityLast;
}

export interface ActivityContext {
  accountsById: Readonly<Record<string, AccountView>>;
  batchesById: Readonly<Record<number, ActionBatchView>>;
}

type Result = ActivityEntry["result"];

const num = (r: Result, key: string): number => {
  const v = r[key];
  return typeof v === "number" ? v : 0;
};
const has = (r: Result, key: string): boolean => typeof r[key] === "number";
const ACTION_WORD = { delete: "Trash", archive: "Archive", keep: "Keep" } as const;

function onlyAction(r: Result): keyof typeof ACTION_WORD | null {
  const nonZero = (["delete", "archive", "keep"] as const).filter((k) => num(r, k) > 0);
  return nonZero.length === 1 ? (nonZero[0] ?? null) : null;
}

function batchResult(r: Result): string {
  if (!has(r, "executed")) return "Done";
  const skipped = num(r, "skipped");
  const failed = num(r, "failed");
  if (skipped === 0 && failed === 0) return "Done";
  return [
    `${formatCount(num(r, "executed"))} done`,
    skipped > 0 ? `${formatCount(skipped)} already moved` : "",
    failed > 0 ? `${formatCount(failed)} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Batches are kept 7 days, so an older or unknown batch can no longer be undone.
// A keep-only batch has nothing to restore (the server still reports it undoable), so its cell stays empty.
function batchLast(e: ActivityEntry, ctx: ActivityContext): ActivityLast {
  if (isKeepOnly({ delete: num(e.result, "delete"), archive: num(e.result, "archive") })) return null;
  const batch = e.batchId === null ? undefined : ctx.batchesById[e.batchId];
  if (!batch) return { kind: "expired" };
  if (batch.undoneAt) return { kind: "undone" };
  return batch.undoable ? { kind: "undo", batchId: batch.id } : { kind: "expired" };
}

/**
 * UI spec 5.4 table. The audit log stores counts and codes only, never addresses or names.
 * Tick audit rows (reauth_required, config_error) may carry a reason code or nothing, so their
 * result is never read.
 */
export function describeActivity(e: ActivityEntry, ctx: ActivityContext): ActivityRow {
  const known = e.accountId === null ? undefined : ctx.accountsById[e.accountId];
  const account = e.accountId === null ? "All accounts" : (known?.email ?? "A removed account");
  const email = e.accountId === null ? "" : (known?.email ?? "a removed account");
  const emails = plural(e.count, "email", "emails");
  const r = e.result;
  const base = { account, last: null as ActivityLast };
  switch (e.kind) {
    case "cleanup": {
      const groups = num(r, "groups");
      const detail = groups > 0 ? `${emails}, ${plural(groups, "sender group", "sender groups")}` : emails;
      return { ...base, verb: "Clean up", detail, result: batchResult(r), last: batchLast(e, ctx) };
    }
    case "approve": {
      const only = onlyAction(r);
      const verb = only ? ACTION_WORD[only] : "Approved";
      return { ...base, verb, detail: emails, result: batchResult(r), last: batchLast(e, ctx) };
    }
    case "override": {
      const only = onlyAction(r);
      const detail = only ? `${emails} to ${ACTION_WORD[only]}` : emails;
      return { ...base, verb: "Changed", detail, result: batchResult(r), last: batchLast(e, ctx) };
    }
    case "undo": {
      const failed = num(r, "failed");
      const result =
        failed > 0 ? `${formatCount(num(r, "restored"))} restored · ${formatCount(failed)} failed` : "Done";
      return { ...base, verb: "Undo", detail: `${emails} restored`, result };
    }
    case "account_connected":
      return { ...base, verb: "Connected", detail: email, result: "Sorting started" };
    case "account_reconnected":
      return { ...base, verb: "Reconnected", detail: email, result: "Sorting resumed" };
    case "account_disconnected":
      return { ...base, verb: "Disconnected", detail: "a mailbox", result: "Data removed tonight" };
    case "account_purged":
      return { ...base, verb: "Removed data", detail: "disconnected mailbox", result: "Done" };
    case "account_paused":
      return { ...base, verb: "Paused", detail: email, result: "Done" };
    case "account_resumed":
      return { ...base, verb: "Resumed", detail: email, result: "Done" };
    case "reauth_required": {
      const needsReconnect = known?.status === "needs_reauth";
      const last: ActivityLast = needsReconnect ? { kind: "reconnect", account: known } : null;
      return { ...base, verb: "Needs reconnect", detail: email, result: "Sorting paused", last };
    }
    case "config_error":
      return {
        ...base,
        verb: "Setup error",
        detail: email,
        result: "Sorting paused",
        last: { kind: "route", label: "Open Accounts", to: "/accounts" },
      };
    case "policy_updated": {
      const counted = has(r, "allow") || has(r, "deny");
      return {
        ...base,
        verb: "Rules updated",
        detail: "",
        result: counted
          ? `Always keep ${formatCount(num(r, "allow"))} · Always OK to trash ${formatCount(num(r, "deny"))}`
          : "Saved",
        last: { kind: "route", label: "Open Rules", to: "/rules" },
      };
    }
    case "calibration":
      return {
        ...base,
        verb: "Threshold tuned",
        detail: `checked ${plural(e.count, "trash decision", "trash decisions")}`,
        result: has(r, "tauDelete") ? `Now ${toPercent(num(r, "tauDelete"))}%` : "Unchanged",
      };
    case "purge":
      return {
        ...base,
        verb: "Nightly cleanup",
        detail: `${plural(e.count, "old record", "old records")} removed`,
        result: "Done",
      };
    case "unsubscribe": {
      const done = r["outcome"] === "unsubscribed";
      return {
        ...base,
        verb: done ? "Unsubscribed" : "Unsubscribe failed",
        detail: "one sender",
        result: unsubscribeActivityResult(r["outcome"]),
      };
    }
    default:
      return { ...base, verb: "Activity", detail: emails, result: "Done" };
  }
}
