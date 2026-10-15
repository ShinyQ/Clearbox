import type { ProviderKind } from "@clearbox/core";
import type { AccountPhase, AccountStatus, AccountSync, AccountView } from "../../shared/api.ts";
import type { EncryptedValue } from "../crypto/aead.ts";
import { bytesFromBlob } from "../crypto/base64.ts";
import { flag, toIso, toIsoOrNull } from "./sql.ts";

export type AccountRowStatus = "active" | "needs_reauth" | "config_error" | "disconnected";

export interface AccountRow {
  id: string;
  provider: ProviderKind;
  email: string;
  provider_user_id: string;
  status: AccountRowStatus;
  status_reason: string | null;
  paused: number;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
  granted_scopes: string;
  owner_aliases_json: string;
  archive_folder_id: string | null;
  phase: AccountPhase;
  sent_cursor: string | null;
  sent_scanned: number;
  backfill_cursor: string | null;
  backfill_done: number;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
  page_size: number;
  attempts: number;
  backoff_until: number | null;
  next_tick_at: number;
  last_tick_at: number | null;
  tick_started_at: number | null;
  tick_finished_at: number | null;
  last_error: string | null;
  messages_ingested: number;
  inbox_estimate: number | null;
  created_at: number;
  updated_at: number;
}

export interface Account {
  id: string;
  provider: ProviderKind;
  email: string;
  providerUserId: string;
  status: AccountRowStatus;
  statusReason: string | null;
  paused: boolean;
  keyVersion: number;
  refreshToken: EncryptedValue | null;
  accessToken: EncryptedValue | null;
  accessExpiresAt: number | null;
  grantedScopes: string[];
  ownerAliases: string[];
  archiveFolderId: string | null;
  phase: AccountPhase;
  sentCursor: string | null;
  sentScanned: number;
  backfillCursor: string | null;
  backfillDone: boolean;
  incrementalCursor: string;
  lastIncrementalAt: number | null;
  watermarkReceivedAt: number | null;
  pageSize: number;
  attempts: number;
  backoffUntil: number | null;
  nextTickAt: number;
  lastTickAt: number | null;
  tickStartedAt: number | null;
  tickFinishedAt: number | null;
  lastError: string | null;
  messagesIngested: number;
  /** rev 2.1 A4: provider inbox total, written by plan 04. */
  inboxEstimate: number | null;
  createdAt: number;
  updatedAt: number;
}

function pair(ciphertext: unknown, iv: unknown): EncryptedValue | null {
  const c = bytesFromBlob(ciphertext);
  const i = bytesFromBlob(iv);
  return c && i ? { ciphertext: c, iv: i } : null;
}

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    providerUserId: row.provider_user_id,
    status: row.status,
    statusReason: row.status_reason,
    paused: flag(row.paused),
    keyVersion: row.key_version,
    refreshToken: pair(row.enc_refresh_token, row.refresh_iv),
    accessToken: pair(row.enc_access_token, row.access_iv),
    accessExpiresAt: row.access_expires_at,
    grantedScopes: row.granted_scopes.split(" ").filter((s) => s !== ""),
    ownerAliases: JSON.parse(row.owner_aliases_json) as string[],
    archiveFolderId: row.archive_folder_id,
    phase: row.phase,
    sentCursor: row.sent_cursor,
    sentScanned: row.sent_scanned,
    backfillCursor: row.backfill_cursor,
    backfillDone: flag(row.backfill_done),
    incrementalCursor: row.incremental_cursor,
    lastIncrementalAt: row.last_incremental_at,
    watermarkReceivedAt: row.watermark_received_at,
    pageSize: row.page_size,
    attempts: row.attempts,
    backoffUntil: row.backoff_until,
    nextTickAt: row.next_tick_at,
    lastTickAt: row.last_tick_at,
    tickStartedAt: row.tick_started_at,
    tickFinishedAt: row.tick_finished_at,
    lastError: row.last_error,
    messagesIngested: row.messages_ingested,
    inboxEstimate: row.inbox_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
  const row = await db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function listAccounts(
  db: D1Database,
  opts: { includeDisconnected: boolean },
): Promise<Account[]> {
  const res = await db
    .prepare("SELECT * FROM accounts WHERE (?1 = 1 OR status <> 'disconnected') ORDER BY created_at, id")
    .bind(opts.includeDisconnected ? 1 : 0)
    .run<AccountRow>();
  return res.results.map(mapAccount);
}

export async function findOpenAccountByEmail(
  db: D1Database,
  provider: ProviderKind,
  email: string,
): Promise<Account | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE provider = ?1 AND email = ?2 AND status <> 'disconnected'")
    .bind(provider, email)
    .first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export interface NewAccount {
  id: string;
  provider: ProviderKind;
  email: string;
  providerUserId: string;
  grantedScopes: readonly string[];
  ownerAliases: readonly string[];
  archiveFolderId: string | null;
  incrementalCursor: string;
  keyVersion: number;
  refreshToken: EncryptedValue;
  accessToken: EncryptedValue;
  accessExpiresAt: number;
  now: number;
}

export function insertAccountStmt(db: D1Database, a: NewAccount): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounts (id, provider, email, provider_user_id, status, key_version, enc_refresh_token, refresh_iv,
         enc_access_token, access_iv, access_expires_at, granted_scopes, owner_aliases_json, archive_folder_id,
         phase, incremental_cursor, next_tick_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'sent_backfill', ?14, 0, ?15, ?15)`,
    )
    .bind(
      a.id,
      a.provider,
      a.email,
      a.providerUserId,
      a.keyVersion,
      a.refreshToken.ciphertext,
      a.refreshToken.iv,
      a.accessToken.ciphertext,
      a.accessToken.iv,
      a.accessExpiresAt,
      a.grantedScopes.join(" "),
      JSON.stringify(a.ownerAliases),
      a.archiveFolderId,
      a.incrementalCursor,
      a.now,
    );
}

export interface ReconnectUpdate {
  providerUserId: string;
  keyVersion: number;
  refreshToken: EncryptedValue;
  accessToken: EncryptedValue;
  accessExpiresAt: number;
  grantedScopes: readonly string[];
  ownerAliases: readonly string[];
  archiveFolderId: string | null;
  now: number;
}

/** Contracts 7.13 step 7: new tokens and status active; cursors are kept. */
export function reconnectAccountStmt(db: D1Database, id: string, u: ReconnectUpdate): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET provider_user_id = ?2, status = 'active', status_reason = NULL, key_version = ?3,
         enc_refresh_token = ?4, refresh_iv = ?5, enc_access_token = ?6, access_iv = ?7, access_expires_at = ?8,
         granted_scopes = ?9, owner_aliases_json = ?10, archive_folder_id = ?11, attempts = 0, backoff_until = NULL,
         last_error = NULL, updated_at = ?12
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(
      id,
      u.providerUserId,
      u.keyVersion,
      u.refreshToken.ciphertext,
      u.refreshToken.iv,
      u.accessToken.ciphertext,
      u.accessToken.iv,
      u.accessExpiresAt,
      u.grantedScopes.join(" "),
      JSON.stringify(u.ownerAliases),
      u.archiveFolderId,
      u.now,
    );
}

export function setPausedStmt(db: D1Database, id: string, paused: boolean, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE accounts SET paused = ?2, updated_at = ?3 WHERE id = ?1 AND status <> 'disconnected'")
    .bind(id, paused ? 1 : 0, now);
}

export function disconnectAccountStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET status = 'disconnected', enc_refresh_token = NULL, refresh_iv = NULL,
         enc_access_token = NULL, access_iv = NULL, access_expires_at = NULL, updated_at = ?2
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(id, now);
}

export function markAccountStatusStmt(
  db: D1Database,
  id: string,
  status: "needs_reauth" | "config_error",
  reason: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE accounts SET status = ?2, status_reason = ?3, updated_at = ?4 WHERE id = ?1 AND status <> 'disconnected'",
    )
    .bind(id, status, reason, now);
}

export function accessTokenUpdateStmt(
  db: D1Database,
  id: string,
  access: EncryptedValue,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE accounts SET enc_access_token = ?2, access_iv = ?3, access_expires_at = ?4, updated_at = ?5 WHERE id = ?1 AND status <> 'disconnected'",
    )
    .bind(id, access.ciphertext, access.iv, expiresAt, now);
}

export function tokensUpdateStmt(
  db: D1Database,
  id: string,
  refresh: EncryptedValue,
  access: EncryptedValue,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET enc_refresh_token = ?2, refresh_iv = ?3, enc_access_token = ?4, access_iv = ?5,
         access_expires_at = ?6, updated_at = ?7
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(id, refresh.ciphertext, refresh.iv, access.ciphertext, access.iv, expiresAt, now);
}

/** rev 2.1 A4: written by plan 04 (first tick, then at most daily during backfill). */
export function setInboxEstimateStmt(
  db: D1Database,
  id: string,
  estimate: number | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE accounts SET inbox_estimate = ?2, updated_at = ?3 WHERE id = ?1 AND status <> 'disconnected'",
    )
    .bind(id, estimate, now);
}

export interface OpenCounts {
  pending: number;
  awaitingModel: number;
}

export function toAccountSync(a: Account, counts: OpenCounts): AccountSync {
  return {
    phase: a.phase,
    backfillDone: a.backfillDone,
    messagesIngested: a.messagesIngested,
    pendingCount: counts.pending,
    awaitingModelCount: counts.awaitingModel,
    lastTickAt: toIsoOrNull(a.lastTickAt),
    nextTickAt: a.nextTickAt > 0 ? toIso(a.nextTickAt) : null,
    backoffUntil: toIsoOrNull(a.backoffUntil),
    lastErrorCode: a.lastError,
    pageSize: a.pageSize,
    inboxEstimate: a.inboxEstimate,
  };
}

export function toAccountView(a: Account, counts: OpenCounts): AccountView {
  if (a.status === "disconnected") throw new Error("disconnected accounts have no view");
  const status: AccountStatus = a.status;
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    status,
    statusReason: a.statusReason,
    paused: a.paused,
    archiveSupported: a.provider === "gmail" || a.archiveFolderId !== null,
    sync: toAccountSync(a, counts),
    createdAt: toIso(a.createdAt),
  };
}
