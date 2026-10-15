import type { SuggestedAction } from "@clearbox/core";
import type { ApiReason } from "../../../src/shared/api.ts";
import type { FakeItem } from "./fake-api-state.ts";
import { ACC_GMAIL, ACC_OUTLOOK, HOUR, T0, iso } from "./fixtures-accounts.ts";

export interface GroupSpec {
  accountId: string;
  sender: string;
  name: string | null;
  action: SuggestedAction;
  confidences: number[];
  subjects: string[];
  reasons: ApiReason[];
  ceilingApplied?: boolean;
  snippet?: string | null;
}

export function makeGroupItems(spec: GroupSpec, startId: number): FakeItem[] {
  const domain = spec.sender.includes("@") ? (spec.sender.split("@")[1] ?? "") : "";
  const gmail = spec.accountId === ACC_GMAIL;
  return spec.confidences.map((confidence, i) => {
    const id = startId + i;
    return {
      id,
      accountId: spec.accountId,
      sender: spec.sender,
      senderName: spec.name,
      domain,
      action: spec.action,
      confidence,
      subject: spec.subjects[i % spec.subjects.length] ?? null,
      snippet: spec.snippet === undefined ? `Synthetic preview text for message ${id}.` : spec.snippet,
      receivedAt: iso(T0 - (i + 1) * 3 * HOUR),
      isRead: i % 2 === 0,
      reasons: spec.reasons,
      ceilingApplied: spec.ceilingApplied ?? false,
      deepLink: gmail
        ? `https://mail.google.com/mail/u/?authuser=you%40example.com#all/m${id}`
        : `https://outlook.office.com/mail/id/m${id}`,
      status: "pending",
      finalAction: null,
    };
  });
}

const r = (code: ApiReason["code"], text: string): ApiReason => ({ code, text });

export const DEFAULT_GROUPS: GroupSpec[] = [
  {
    accountId: ACC_GMAIL,
    sender: "promo@northwind.example",
    name: "Northwind Deals",
    action: "delete",
    confidences: [0.99, 0.98, 0.97, 0.97, 0.96, 0.96],
    subjects: ["Flash sale ends tonight", "Your weekly picks", "Last chance: 70% off"],
    reasons: [
      r("prior_sender_deleted", "You trashed 41 of 44 from this sender"),
      r("low_open_rate", "Opened 2% of 52 emails from this sender"),
      r("list_unsubscribe", "Has an unsubscribe link"),
    ],
  },
  {
    accountId: ACC_GMAIL,
    sender: "digest@news.example",
    name: "Daily Digest",
    action: "delete",
    confidences: [0.93, 0.91, 0.9, 0.88],
    subjects: ["Your morning digest"],
    reasons: [r("bulk_mail", "Sent as bulk mail"), r("old_unread", "Unread for 9 days")],
  },
  {
    accountId: ACC_OUTLOOK,
    sender: "orders@contoso.example",
    name: "Contoso Orders",
    action: "archive",
    confidences: [0.95, 0.92, 0.9],
    subjects: ["Your order has shipped", "Receipt for order 4471"],
    reasons: [r("guard_record_pattern", "Looks like a record (receipt)")],
    ceilingApplied: true,
  },
  {
    accountId: ACC_GMAIL,
    sender: "updates@fabrikam.example",
    name: "Fabrikam Updates",
    action: "archive",
    confidences: [0.84, 0.8, 0.78, 0.74],
    subjects: ["Release notes"],
    reasons: [r("category", "Filed under updates")],
  },
  {
    accountId: ACC_GMAIL,
    sender: "deals@tailspin.example",
    name: "Tailspin Travel",
    action: "delete",
    confidences: [0.9, 0.85, 0.8],
    subjects: ["Fares to the coast"],
    reasons: [r("list_unsubscribe", "Has an unsubscribe link")],
  },
  {
    accountId: ACC_OUTLOOK,
    sender: "mom@family.example",
    name: "Mom",
    action: "keep",
    confidences: [0.92, 0.88],
    subjects: ["Sunday lunch?"],
    reasons: [r("guard_correspondent", "You have written to this sender")],
  },
  {
    accountId: ACC_GMAIL,
    sender: "builds@ci.example",
    name: "Build Bot",
    action: "unsure",
    confidences: [0.55, 0.52, 0.5, 0.48, 0.45],
    subjects: ["Build 1042 finished"],
    reasons: [r("low_confidence", "Not confident enough to suggest an action")],
  },
];

export function defaultItems(): FakeItem[] {
  let next = 1000;
  return DEFAULT_GROUPS.flatMap((spec) => {
    const items = makeGroupItems(spec, next);
    next += 100;
    return items;
  });
}
