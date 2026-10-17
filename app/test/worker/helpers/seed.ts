import type {
  ActionKind,
  Ceiling,
  DecisionSegment,
  ProviderKind,
  Reason,
  Signals,
  SuggestedAction,
} from "@clearbox/core";
import { makeSignals } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import type { AccountPhase, SuggestionStatus } from "../../../src/shared/api.ts";
import { CURRENT_KEY_VERSION, encryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { getAccount, insertAccountStmt } from "../../../src/worker/db/accounts.ts";
import type { Account, AccountRowStatus } from "../../../src/worker/db/accounts.ts";
import { insertLabelStmt } from "../../../src/worker/db/labels.ts";
import type { LabelSource } from "../../../src/worker/db/labels.ts";
import { insertMessageStmt } from "../../../src/worker/db/messages.ts";
import type { MessageInsert } from "../../../src/worker/db/messages.ts";
import { insertSuggestionStmt } from "../../../src/worker/db/suggestions.ts";

export const SEED_NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 3_600_000;
let seq = 0;

export async function testEncKey(): Promise<CryptoKey> {
  return importEncKey(base64ToBytes(env.TOKEN_ENC_KEY));
}

export interface SeedAccountInput {
  id?: string;
  provider?: ProviderKind;
  email?: string;
  status?: AccountRowStatus;
  statusReason?: string | null;
  paused?: boolean;
  archiveFolderId?: string | null;
  refreshToken?: string;
  /** null stores no cached access token. */
  accessToken?: string | null;
  accessExpiresAt?: number;
  phase?: AccountPhase;
  createdAt?: number;
  lastTickAt?: number | null;
  nextTickAt?: number;
}

export async function seedAccount(input: SeedAccountInput = {}): Promise<Account> {
  seq += 1;
  const id = input.id ?? `acc_${seq.toString(16).padStart(16, "0")}`;
  const provider = input.provider ?? "gmail";
  const email = input.email ?? `mailbox${seq}@example.com`;
  const key = await testEncKey();
  const ctx = (kind: "refresh" | "access") => ({ accountId: id, kind, keyVersion: CURRENT_KEY_VERSION });
  const refresh = await encryptToken(key, input.refreshToken ?? `refresh-${id}`, ctx("refresh"));
  const access = await encryptToken(key, input.accessToken ?? `access-${id}`, ctx("access"));
  const createdAt = input.createdAt ?? SEED_NOW - 30 * 24 * HOUR;
  await insertAccountStmt(env.DB, {
    id,
    provider,
    email,
    providerUserId: provider === "gmail" ? email : `user-${id}`,
    grantedScopes:
      provider === "gmail"
        ? ["https://www.googleapis.com/auth/gmail.modify"]
        : ["Mail.ReadWrite", "offline_access", "User.Read"],
    ownerAliases: [],
    archiveFolderId:
      input.archiveFolderId === undefined
        ? provider === "outlook"
          ? "folder-archive"
          : null
        : input.archiveFolderId,
    incrementalCursor: JSON.stringify({ v: 1, historyId: "1" }),
    keyVersion: CURRENT_KEY_VERSION,
    refreshToken: refresh,
    accessToken: access,
    accessExpiresAt: input.accessExpiresAt ?? Date.UTC(2100, 0, 1),
    now: createdAt,
  }).run();
  await env.DB.prepare(
    `UPDATE accounts SET status = ?2, status_reason = ?3, paused = ?4, phase = ?5, last_tick_at = ?6, next_tick_at = ?7,
       enc_access_token = CASE WHEN ?8 = 1 THEN NULL ELSE enc_access_token END,
       access_iv = CASE WHEN ?8 = 1 THEN NULL ELSE access_iv END,
       access_expires_at = CASE WHEN ?8 = 1 THEN NULL ELSE access_expires_at END
     WHERE id = ?1`,
  )
    .bind(
      id,
      input.status ?? "active",
      input.statusReason ?? null,
      input.paused ? 1 : 0,
      input.phase ?? "incremental",
      input.lastTickAt ?? null,
      input.nextTickAt ?? 0,
      input.accessToken === null ? 1 : 0,
    )
    .run();
  const account = await getAccount(env.DB, id);
  if (!account) throw new Error("seedAccount failed");
  return account;
}

type PerIndex<T> = T | ((i: number) => T);
const at = <T>(value: PerIndex<T> | undefined, i: number): T | undefined =>
  typeof value === "function" ? (value as (i: number) => T)(i) : value;

export async function seedMessages(
  accountId: string,
  n: number,
  overrides?: PerIndex<Partial<MessageInsert>>,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    const o = at(overrides, i) ?? {};
    const m: MessageInsert = {
      providerMsgId: `msg-${seq}`,
      threadId: `thread-${seq}`,
      internetMessageId: `<m${seq}@example.com>`,
      sender: "news@shop.example.com",
      senderName: "Shop News",
      senderDomain: "example.com",
      subject: `Weekly deals ${seq}`,
      snippet: "Synthetic snippet for tests",
      receivedAt: SEED_NOW - (i + 1) * HOUR,
      isRead: false,
      signalsJson: JSON.stringify(makeSignals()),
      webLink: null,
      createdAt: SEED_NOW - (i + 1) * HOUR,
      ...o,
    };
    await insertMessageStmt(env.DB, accountId, m).run();
    const row = await env.DB.prepare("SELECT id FROM messages WHERE account_id = ?1 AND provider_msg_id = ?2")
      .bind(accountId, m.providerMsgId)
      .first<{ id: number }>();
    if (!row) throw new Error("seedMessages failed");
    ids.push(row.id);
  }
  return ids;
}

export interface SeedSuggestionOptions {
  sender?: string;
  senderName?: string | null;
  senderDomain?: string;
  subject?: string | null;
  snippet?: string | null;
  receivedAt?: number;
  isRead?: boolean;
  webLink?: string | null;
  signals?: Partial<Signals>;
  status?: SuggestionStatus;
  action?: SuggestedAction;
  confidence?: number;
  distribution?: { delete: number; archive: number; keep: number; unsure: number } | null;
  margin?: number | null;
  ceiling?: Ceiling;
  ceilingApplied?: boolean;
  /** contracts 12.10; omitted leaves NULL. */
  segment?: DecisionSegment | null;
  reasons?: Reason[];
  modelVersion?: string | null;
  policyVersion?: number;
  createdAt?: number;
  finalAction?: ActionKind | null;
  decidedVia?: "approve" | "override" | "cleanup" | null;
  batchId?: number | null;
  labelId?: number | null;
}

export async function seedSuggestions(
  accountId: string,
  n: number,
  opts?: PerIndex<SeedSuggestionOptions>,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = at(opts, i) ?? {};
    const sender = o.sender ?? "news@shop.example.com";
    const senderDomain = o.senderDomain ?? "example.com";
    const [messageId] = await seedMessages(accountId, 1, {
      sender,
      senderDomain,
      senderName: o.senderName === undefined ? "Shop News" : o.senderName,
      subject: o.subject === undefined ? `Weekly deals ${i}` : o.subject,
      snippet: o.snippet === undefined ? "Synthetic snippet for tests" : o.snippet,
      receivedAt: o.receivedAt ?? SEED_NOW - (i + 1) * HOUR,
      isRead: o.isRead ?? false,
      webLink: o.webLink ?? null,
      signalsJson: JSON.stringify(makeSignals({ senderAddress: sender, senderDomain, ...o.signals })),
    });
    if (messageId === undefined) throw new Error("seedSuggestions failed");
    const action = o.action ?? "delete";
    const confidence = o.confidence ?? 0.9;
    const dist =
      o.distribution === undefined
        ? { delete: action === "delete" ? confidence : 0.05, archive: 0.03, keep: 0.02, unsure: 0 }
        : o.distribution;
    const status = o.status ?? "pending";
    const providerMsgId = (
      await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1")
        .bind(messageId)
        .first<{ provider_msg_id: string }>()
    )?.provider_msg_id;
    if (!providerMsgId) throw new Error("seedSuggestions failed");
    const createdAt = o.createdAt ?? SEED_NOW - 60_000;
    await insertSuggestionStmt(env.DB, accountId, providerMsgId, {
      sender,
      senderDomain,
      status: status === "awaiting_model" ? "awaiting_model" : "pending",
      action: status === "awaiting_model" ? null : action,
      confidence: status === "awaiting_model" ? null : confidence,
      pDelete: dist?.delete ?? null,
      pArchive: dist?.archive ?? null,
      pKeep: dist?.keep ?? null,
      pUnsure: dist?.unsure ?? null,
      modelPDelete: dist?.delete ?? null,
      margin: o.margin === undefined ? 0.5 : o.margin,
      importance: 0.5,
      flagsJson: JSON.stringify({ isRecord: 0.05, isExpired: 0.1, isFromHuman: 0.05 }),
      ceiling: o.ceiling ?? "delete",
      ceilingApplied: o.ceilingApplied ?? false,
      reasonsJson: JSON.stringify(o.reasons ?? [{ code: "list_unsubscribe", params: {} }]),
      modelVersion: o.modelVersion === undefined ? "fake/fake-1" : o.modelVersion,
      policyVersion: o.policyVersion ?? 1,
      decisionAttempts: 0,
      retryAfter: null,
      createdAt,
      expiresAt: createdAt + 90 * 24 * HOUR,
    }).run();
    if (o.segment !== undefined) {
      await env.DB.prepare("UPDATE suggestions SET segment = ?2 WHERE message_id = ?1")
        .bind(messageId, o.segment)
        .run();
    }
    if (status !== "pending" && status !== "awaiting_model") {
      await env.DB.prepare(
        `UPDATE suggestions SET status = ?2, final_action = ?3, decided_via = ?4, batch_id = ?5, label_id = ?6,
           decided_at = CASE WHEN ?3 IS NULL THEN NULL ELSE ?7 END
         WHERE message_id = ?1`,
      )
        .bind(
          messageId,
          status,
          o.finalAction ?? null,
          o.decidedVia ?? null,
          o.batchId ?? null,
          o.labelId ?? null,
          createdAt,
        )
        .run();
    }
    ids.push(messageId);
  }
  return ids;
}

export interface SeedLabelOptions {
  sender?: string;
  senderDomain?: string;
  suggestedAction?: SuggestedAction;
  ownerAction?: ActionKind;
  source?: LabelSource;
  pDelete?: number | null;
  createdAt?: number;
  messageId?: number | null;
}

export async function seedLabels(
  accountId: string,
  n: number,
  opts?: PerIndex<SeedLabelOptions>,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = at(opts, i) ?? {};
    const res = await insertLabelStmt(env.DB, accountId, {
      messageId: o.messageId ?? null,
      sender: o.sender ?? "news@shop.example.com",
      senderDomain: o.senderDomain ?? "example.com",
      subjectTrunc: "Weekly deals",
      suggestedAction: o.suggestedAction ?? "delete",
      ownerAction: o.ownerAction ?? "delete",
      source: o.source ?? "approve",
      pDelete: o.pDelete === undefined ? 0.9 : o.pDelete,
      margin: 0.5,
      ceiling: "delete",
      modelVersion: "fake/fake-1",
      policyVersion: 1,
      now: o.createdAt ?? SEED_NOW - i * 1_000,
    }).run();
    ids.push(Number(res.meta.last_row_id));
  }
  return ids;
}

export async function getSuggestionRow(id: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM suggestions WHERE message_id = ?1")
    .bind(id)
    .first<Record<string, unknown>>();
}
