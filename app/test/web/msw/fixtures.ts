import type { SuggestedAction } from "@clearbox/core";
import type {
  AccountSync,
  AccountView,
  ActionBatchView,
  ActivityEntry,
  ApiReason,
  Insights,
  MeResponse,
  PolicyResponse,
} from "../../../src/shared/api.ts";
import type { FakeItem } from "./fake-api.ts";

export const OWNER = "owner@example.test";
export const T0 = Date.parse("2026-10-15T10:00:00.000Z");
export const ACC_GMAIL = "acc_0000000000000001";
export const ACC_OUTLOOK = "acc_0000000000000002";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function makeSync(overrides: Partial<AccountSync> = {}): AccountSync {
  return {
    phase: "incremental",
    backfillDone: true,
    messagesIngested: 32_118,
    pendingCount: 0,
    awaitingModelCount: 0,
    lastTickAt: iso(T0 - 4 * MIN),
    nextTickAt: iso(T0 + 26 * MIN),
    backoffUntil: null,
    lastErrorCode: null,
    pageSize: 25,
    inboxEstimate: null,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: ACC_GMAIL,
    provider: "gmail",
    email: "you@example.com",
    status: "active",
    statusReason: null,
    paused: false,
    archiveSupported: true,
    sync: makeSync(),
    createdAt: iso(T0 - 30 * DAY),
    ...overrides,
  };
}

export function defaultAccounts(): AccountView[] {
  return [
    makeAccount({ sync: makeSync({ pendingCount: 20 }) }),
    makeAccount({
      id: ACC_OUTLOOK,
      provider: "outlook",
      email: "you@example.net",
      sync: makeSync({
        phase: "inbox_backfill",
        backfillDone: false,
        messagesIngested: 8_200,
        pendingCount: 7,
        lastTickAt: iso(T0 - 1 * MIN),
        inboxEstimate: 20_000,
      }),
    }),
  ];
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    email: OWNER,
    environment: "production",
    freeTier: true,
    providers: { gmail: true, outlook: true },
    issues: [],
    tauDelete: 0.86,
    serverTime: iso(T0),
    ...overrides,
  };
}

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

export function makeInsights(accounts: AccountView[]): Insights {
  const weekStarts = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
  const cleaned = [420, 730, 512, 640, 980, 1284];
  const undone = [3, 5, 0, 2, 9, 18];
  return {
    precision: { deletePrecision: 0.986, deleteSuggestionsDecided: 412, window: 500 },
    labels: { total: 1912, last7Days: 312 },
    calibration: {
      tauDelete: 0.86,
      outcome: "calibrated",
      ranAt: iso(T0 - 9 * HOUR),
      points: [
        { tau: 0.8, support: 120, precision: 0.979 },
        { tau: 0.86, support: 96, precision: 0.986 },
        { tau: 0.9, support: 60, precision: 0.99 },
      ],
    },
    budget: {
      date: "2026-10-15",
      rowsWritten: 21_080,
      rowsCap: 90_000,
      ingestStopRows: 65_000,
      d1DailyWriteLimit: 100_000,
      ticks: 900,
      messagesIngested: 3_120,
      decisionCalls: 3_412,
      decisionFailures: 2,
      decisionInputTokens: 1_400_000,
      estimatedDecisionCostUsd: 0.0588,
      dbSizeBytes: 182_000_000,
      dbSizeLimitBytes: 500_000_000,
    },
    history: Array.from({ length: 14 }, (_, i) => ({
      date: iso(T0 - (13 - i) * DAY).slice(0, 10),
      rowsWritten: 20_000,
      messagesIngested: 6_000,
      decisionCalls: 3_000,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      status: a.status,
      paused: a.paused,
      sync: a.sync,
    })),
    weekly: weekStarts.map((weekStart, i) => ({
      weekStart,
      cleaned: cleaned[i] ?? 0,
      undone: undone[i] ?? 0,
    })),
  };
}

export function makePolicyResponse(): PolicyResponse {
  const defaults = {
    allowlist: [],
    denylist: [],
    minAgeDays: 3,
    storeSnippets: true,
    labelSubjects: true,
    recordPatterns: ["receipt", "invoice", "tax", "statement", "contract", "medical", "legal"],
  };
  return {
    policy: {
      ...defaults,
      allowlist: ["mom@family.example", "@bank.example"],
      denylist: ["promo@northwind.example"],
    },
    version: 4,
    defaults,
  };
}

export function defaultBatches(): (ActionBatchView & { itemIds: number[] })[] {
  const byAction = (d: number, a: number) => ({ delete: d, archive: a, keep: 0 });
  return [
    {
      id: 3,
      kind: "cleanup",
      createdAt: iso(T0 - 1 * HOUR),
      requestedCount: 1284,
      executedCount: 1280,
      failedCount: 0,
      byAction: byAction(1102, 178),
      undoable: true,
      undoExpiresAt: iso(T0 + 23 * HOUR),
      undoneAt: null,
      itemIds: [],
    },
    {
      id: 2,
      kind: "approve",
      createdAt: iso(T0 - 3 * HOUR),
      requestedCount: 248,
      executedCount: 248,
      failedCount: 0,
      byAction: byAction(248, 0),
      undoable: false,
      undoExpiresAt: iso(T0 + 21 * HOUR),
      undoneAt: iso(T0 - 2 * HOUR),
      itemIds: [],
    },
    {
      id: 1,
      kind: "override",
      createdAt: iso(T0 - 2 * DAY),
      requestedCount: 12,
      executedCount: 12,
      failedCount: 0,
      byAction: byAction(12, 0),
      undoable: false,
      undoExpiresAt: iso(T0 - 1 * DAY),
      undoneAt: null,
      itemIds: [],
    },
  ];
}

export function defaultActivity(): ActivityEntry[] {
  const counts = {
    executed: 0,
    failed: 0,
    skipped: 0,
    retryLater: 0,
    delete: 0,
    archive: 0,
    keep: 0,
    groups: 0,
  };
  return [
    {
      id: 9,
      ts: iso(T0 - 1 * HOUR),
      kind: "cleanup",
      accountId: null,
      batchId: 3,
      count: 1284,
      result: { ...counts, executed: 1280, skipped: 4, delete: 1102, archive: 178, groups: 371 },
    },
    {
      id: 8,
      ts: iso(T0 - 2 * HOUR),
      kind: "undo",
      accountId: ACC_GMAIL,
      batchId: 2,
      count: 248,
      result: { restored: 248, failed: 0 },
    },
    {
      id: 7,
      ts: iso(T0 - 3 * HOUR),
      kind: "approve",
      accountId: ACC_GMAIL,
      batchId: 2,
      count: 248,
      result: { ...counts, executed: 248, delete: 248 },
    },
    {
      id: 6,
      ts: iso(T0 - 2 * DAY),
      kind: "override",
      accountId: ACC_GMAIL,
      batchId: 1,
      count: 12,
      result: { ...counts, executed: 12, delete: 12 },
    },
    {
      id: 5,
      ts: iso(T0 - 2 * DAY - HOUR),
      kind: "policy_updated",
      accountId: null,
      batchId: null,
      count: 0,
      result: { allow: 3, deny: 1 },
    },
    {
      id: 4,
      ts: iso(T0 - 3 * DAY),
      kind: "calibration",
      accountId: null,
      batchId: null,
      count: 312,
      result: { tauDelete: 0.86 },
    },
    {
      id: 3,
      ts: iso(T0 - 3 * DAY - HOUR),
      kind: "purge",
      accountId: null,
      batchId: null,
      count: 4210,
      result: {},
    },
    {
      id: 2,
      ts: iso(T0 - 4 * DAY),
      kind: "reauth_required",
      accountId: ACC_OUTLOOK,
      batchId: null,
      count: 0,
      result: { reason: "invalid_grant" },
    },
    {
      id: 1,
      ts: iso(T0 - 30 * DAY),
      kind: "account_connected",
      accountId: ACC_GMAIL,
      batchId: null,
      count: 0,
      result: {},
    },
  ];
}
