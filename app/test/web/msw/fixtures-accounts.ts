import type { AccountSync, AccountView, MeResponse } from "../../../src/shared/api.ts";

export const OWNER = "owner@example.test";
export const T0 = Date.parse("2026-10-15T10:00:00.000Z");
export const ACC_GMAIL = "acc_0000000000000001";
export const ACC_OUTLOOK = "acc_0000000000000002";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

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
