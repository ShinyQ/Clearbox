export const REASON_CODES = [
  "guard_starred",
  "guard_replied",
  "guard_allowlist",
  "guard_too_recent",
  "guard_correspondent",
  "guard_attachment",
  "guard_record_pattern",
  "deny_listed",
  "prior_sender_deleted",
  "prior_sender_kept",
  "prior_domain_deleted",
  "prior_domain_kept",
  "low_open_rate",
  "list_unsubscribe",
  "bulk_mail",
  "auto_sent",
  "category",
  "flag_expired",
  "flag_record",
  "flag_human",
  "old_unread",
  "auth_failed",
  "model_important",
  "model_unavailable",
  "low_confidence",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonParams = Readonly<Record<string, string | number>>;
export interface Reason {
  code: ReasonCode;
  params: ReasonParams;
}

/** English templates; {name} placeholders are replaced by params. No em dashes. "trashed" wording per contracts 12.2. */
export const REASON_TEMPLATES: Readonly<Record<ReasonCode, string>> = {
  guard_starred: "You starred or flagged this email",
  guard_replied: "You replied in this conversation",
  guard_allowlist: "Sender is on your keep list",
  guard_too_recent: "Received less than {minAgeDays} days ago",
  guard_correspondent: "You have written to this sender",
  guard_attachment: "Has attachments",
  guard_record_pattern: "Looks like a record ({pattern})",
  deny_listed: "Sender is on your delete list",
  prior_sender_deleted: "You trashed {deletes} of {total} from this sender",
  prior_sender_kept: "You kept {keeps} of {total} from this sender",
  prior_domain_deleted: "You trashed {deletes} of {total} from {domain}",
  prior_domain_kept: "You kept {keeps} of {total} from {domain}",
  low_open_rate: "Opened {openPct}% of {seen} emails from this sender",
  list_unsubscribe: "Has an unsubscribe link",
  bulk_mail: "Sent as bulk mail",
  auto_sent: "Sent automatically",
  category: "Filed under {category}",
  flag_expired: "Looks expired or time-bound",
  flag_record: "Looks like a record worth keeping",
  flag_human: "Looks personally written",
  old_unread: "Unread for {ageDays} days",
  auth_failed: "Failed sender authentication ({method})",
  model_important: "Rated {level} importance",
  model_unavailable: "Model unavailable, needs your review",
  low_confidence: "Not confident enough to suggest an action",
};

/** Replaces every {name} placeholder with params[name]; unknown placeholders are left as they are. */
export function renderReason(reason: Reason): string {
  return REASON_TEMPLATES[reason.code].replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    const value = reason.params[name];
    return value === undefined ? whole : String(value);
  });
}
