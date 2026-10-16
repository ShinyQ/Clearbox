import type { GroupKey } from "../../shared/api.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";

export const qk = {
  me: ["me"] as const,
  accounts: ["accounts"] as const,
  summary: (accountId?: string) => ["queue", "summary", { accountId: accountId ?? null }] as const,
  preview: (accountId?: string, actions = "delete,archive") =>
    ["cleanup", "preview", { accountId: accountId ?? null, actions }] as const,
  groups: (f: { accountId?: string | undefined; action?: Verdict | undefined; sort: GroupSort }) =>
    ["groups", { accountId: f.accountId ?? null, action: f.action ?? null, sort: f.sort }] as const,
  group: (key: GroupKey) => ["group", key] as const,
  batches: ["batches"] as const,
  activity: (accountId?: string) => ["activity", { accountId: accountId ?? null }] as const,
  insights: ["insights"] as const,
  policy: ["policy"] as const,
};
