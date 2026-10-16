import type { ProviderKind } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { CURRENT_KEY_VERSION, decryptToken, encryptToken } from "../../../src/worker/crypto/aead.ts";
import { bytesFromBlob } from "../../../src/worker/crypto/base64.ts";
import { testEncKey } from "./seed.ts";

export const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const ACCOUNT_A = "acc_00000000000000a1";
export const ACCOUNT_B = "acc_00000000000000b2";
export const OWNER = "owner@example.test";

const TABLES = [
  "suggestions",
  "messages",
  "labels",
  "sender_priors",
  "senders",
  "correspondents",
  "sent_threads",
  "action_batches",
  "audit_log",
  "budget",
  "leases",
  "accounts",
  "settings",
] as const;

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('tau_delete', '0.8', 0), ('policy_version', '1', 0)",
    ),
  ]);
}

export function graphDeltaLink(folder: "inbox" | "sentitems", token: string): string {
  return `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
}

export function graphCursor(inboxToken: string, sentToken: string, watermark: number): string {
  return JSON.stringify({
    v: 1,
    inboxDeltaLink: graphDeltaLink("inbox", inboxToken),
    sentDeltaLink: graphDeltaLink("sentitems", sentToken),
    watermark: new Date(watermark).toISOString(),
  });
}

export const GMAIL_CURSOR = JSON.stringify({
  v: 1,
  historyId: "1000",
  catchupAfter: null,
  catchupPageToken: null,
});

export interface SeedAccount {
  id?: string;
  provider?: ProviderKind;
  email?: string;
  status?: "active" | "needs_reauth" | "config_error" | "disconnected";
  paused?: boolean;
  phase?: "sent_backfill" | "inbox_backfill" | "incremental";
  pageSize?: number;
  accessToken?: string | null;
  accessExpiresAt?: number;
  refreshToken?: string;
  sentCursor?: string | null;
  sentScanned?: number;
  backfillCursor?: string | null;
  incrementalCursor?: string;
  lastIncrementalAt?: number | null;
  lastTickAt?: number | null;
  nextTickAt?: number;
  backoffUntil?: number | null;
  attempts?: number;
  watermark?: number | null;
  aliases?: string[];
  tickStartedAt?: number | null;
  tickFinishedAt?: number | null;
  /** Defaults to CURRENT_KEY_VERSION; used for both the AAD and the key_version column. */
  keyVersion?: number;
}

/** D1 BLOB column to bytes (plan 03's bytesFromBlob). */
export function bytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  return bytesFromBlob(v);
}

export async function seedTickAccount(s: SeedAccount = {}): Promise<string> {
  const id = s.id ?? ACCOUNT_A;
  const provider = s.provider ?? "outlook";
  const disconnected = s.status === "disconnected";
  const keyVersion = s.keyVersion ?? CURRENT_KEY_VERSION;
  const key = await testEncKey();
  const refresh = disconnected
    ? null
    : await encryptToken(key, s.refreshToken ?? "refresh-1", { accountId: id, kind: "refresh", keyVersion });
  const accessPlain = s.accessToken === undefined ? "access-1" : s.accessToken;
  const access =
    disconnected || accessPlain === null
      ? null
      : await encryptToken(key, accessPlain, { accountId: id, kind: "access", keyVersion });
  const cursor =
    s.incrementalCursor ??
    (provider === "gmail" ? GMAIL_CURSOR : graphCursor("inbox-1", "sent-1", NOW - DAY));
  const values: unknown[] = [
    id,
    provider,
    s.email ?? OWNER,
    s.email ?? OWNER,
    s.status ?? "active",
    s.paused ? 1 : 0,
    keyVersion,
    refresh?.ciphertext ?? null,
    refresh?.iv ?? null,
    access?.ciphertext ?? null,
    access?.iv ?? null,
    access ? (s.accessExpiresAt ?? NOW + 60 * MINUTE) : null,
    provider === "gmail"
      ? "https://www.googleapis.com/auth/gmail.modify"
      : "Mail.ReadWrite User.Read offline_access",
    JSON.stringify(s.aliases ?? []),
    provider === "outlook" ? "archive-folder-1" : null,
    s.phase ?? "inbox_backfill",
    s.sentCursor ?? null,
    s.sentScanned ?? 0,
    s.backfillCursor ?? null,
    0,
    cursor,
    s.lastIncrementalAt === undefined ? NOW - MINUTE : s.lastIncrementalAt,
    s.watermark ?? null,
    s.pageSize ?? 25,
    s.attempts ?? 0,
    s.backoffUntil ?? null,
    s.nextTickAt ?? 0,
    s.lastTickAt ?? null,
    s.tickStartedAt ?? null,
    s.tickFinishedAt ?? null,
    NOW - DAY,
    NOW - DAY,
  ];
  const placeholders = values.map((_, i) => `?${i + 1}`).join(", ");
  await env.DB.prepare(
    `INSERT INTO accounts (id, provider, email, provider_user_id, status, paused, key_version,
       enc_refresh_token, refresh_iv, enc_access_token, access_iv, access_expires_at, granted_scopes,
       owner_aliases_json, archive_folder_id, phase, sent_cursor, sent_scanned, backfill_cursor, backfill_done,
       incremental_cursor, last_incremental_at, watermark_received_at, page_size, attempts, backoff_until,
       next_tick_at, last_tick_at, tick_started_at, tick_finished_at, created_at, updated_at)
     VALUES (${placeholders})`,
  )
    .bind(...values)
    .run();
  return id;
}

export async function one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql)
    .bind(...params)
    .run<T>();
  return r.results;
}

export async function count(table: string, where = "1 = 1", ...params: unknown[]): Promise<number> {
  const r = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params);
  return r?.n ?? 0;
}

export interface AccountSnapshot {
  id: string;
  status: string;
  status_reason: string | null;
  phase: string;
  page_size: number;
  attempts: number;
  backoff_until: number | null;
  next_tick_at: number;
  last_tick_at: number | null;
  last_error: string | null;
  backfill_cursor: string | null;
  backfill_done: number;
  sent_cursor: string | null;
  sent_scanned: number;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
  messages_ingested: number;
  inbox_estimate: number | null;
  updated_at: number;
}

export async function getAccount(id: string): Promise<AccountSnapshot> {
  const row = await one<AccountSnapshot>("SELECT * FROM accounts WHERE id = ?1", id);
  if (row === null) throw new Error(`account ${id} missing`);
  return row;
}

export async function decryptAccountToken(
  accountId: string,
  kind: "refresh" | "access",
): Promise<string | null> {
  const row = await one<Record<string, unknown>>(
    "SELECT key_version, enc_refresh_token, refresh_iv, enc_access_token, access_iv FROM accounts WHERE id = ?1",
    accountId,
  );
  if (row === null) return null;
  const ct = bytes(kind === "refresh" ? row.enc_refresh_token : row.enc_access_token);
  const iv = bytes(kind === "refresh" ? row.refresh_iv : row.access_iv);
  if (ct === null || iv === null) return null;
  const key = await testEncKey();
  return decryptToken(key, { ciphertext: ct, iv }, { accountId, kind, keyVersion: Number(row.key_version) });
}

/** Makes `holder` the live holder of the account lease (the final write batches are fenced on it). */
export async function holdLease(accountId: string, holder: string, now = NOW): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
     VALUES ('account:' || ?1, ?1, ?2, ?3, ?4, NULL)
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at, released_at = NULL`,
  )
    .bind(accountId, holder, now, now + 5 * MINUTE)
    .run();
}

export async function setBudget(date: string, rowsWritten: number, dbSizeBytes = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO budget (date, rows_written, db_size_bytes, updated_at) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (date) DO UPDATE SET rows_written = excluded.rows_written, db_size_bytes = excluded.db_size_bytes`,
  )
    .bind(date, rowsWritten, dbSizeBytes)
    .run();
}

export interface SeedMessage {
  providerId: string;
  sender?: string;
  domain?: string;
  status?: "awaiting_model" | "pending" | "approved" | "executed" | "failed" | "dismissed" | "undone";
  action?: "delete" | "archive" | "keep" | "unsure" | null;
  finalAction?: "delete" | "archive" | "keep" | null;
  receivedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  decisionAttempts?: number;
  retryAfter?: number | null;
}

export async function seedMessage(accountId: string, m: SeedMessage): Promise<number> {
  const sender = m.sender ?? "news@shop.example";
  const domain = m.domain ?? "shop.example";
  const created = m.createdAt ?? NOW - DAY;
  const msg = await one<{ id: number }>(
    `INSERT INTO messages (account_id, provider_msg_id, sender, sender_domain, subject, snippet, received_at,
       is_read, signals_json, created_at)
     VALUES (?1, ?2, ?3, ?4, 'Seeded subject', 'Seeded snippet', ?5, 0, '{}', ?6) RETURNING id`,
    accountId,
    m.providerId,
    sender,
    domain,
    m.receivedAt ?? NOW - 10 * DAY,
    created,
  );
  if (msg === null) throw new Error("message insert failed");
  const status = m.status ?? "pending";
  const action = m.action === undefined ? (status === "awaiting_model" ? null : "delete") : m.action;
  const finalAction = m.finalAction ?? (status === "executed" || status === "undone" ? "delete" : null);
  await env.DB.prepare(
    `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, ceiling,
       policy_version, decision_attempts, retry_after, final_action, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'delete', 1, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      msg.id,
      accountId,
      sender,
      domain,
      status,
      action,
      action === null ? null : 0.9,
      m.decisionAttempts ?? 0,
      m.retryAfter ?? null,
      finalAction,
      created,
      m.updatedAt ?? created,
      m.expiresAt ?? NOW + 30 * DAY,
    )
    .run();
  return msg.id;
}

export async function seedExpiredBulk(accountId: string, n: number, expiresAt: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?2)
       INSERT INTO messages (account_id, provider_msg_id, sender, sender_domain, subject, received_at, is_read,
         signals_json, created_at)
       SELECT ?1, 'bulk-' || i, 'bulk@shop.example', 'shop.example', 'Bulk', ?3, 0, '{}', ?3 FROM seq`,
    ).bind(accountId, n, NOW - 40 * DAY),
    env.DB.prepare(
      `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, ceiling,
         policy_version, created_at, updated_at, expires_at)
       SELECT id, account_id, sender, sender_domain, 'pending', 'delete', 'delete', 1, ?2, ?2, ?3
       FROM messages WHERE account_id = ?1 AND provider_msg_id LIKE 'bulk-%'`,
    ).bind(accountId, NOW - 40 * DAY, expiresAt),
  ]);
}

export interface SeedLabel {
  sender?: string;
  domain?: string;
  subject?: string | null;
  pDelete: number | null;
  margin: number | null;
  ownerAction: "delete" | "archive" | "keep";
  suggested?: "delete" | "archive" | "keep" | "unsure";
  ceiling?: "delete" | "archive" | "keep";
}

export async function seedLabel(accountId: string, l: SeedLabel): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action,
       owner_action, source, p_delete, margin, ceiling, policy_version, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 'approve', ?7, ?8, ?9, 1, ?10, ?10)`,
  )
    .bind(
      accountId,
      l.sender ?? "news@shop.example",
      l.domain ?? "shop.example",
      l.subject ?? "Label subject",
      l.suggested ?? "delete",
      l.ownerAction,
      l.pDelete,
      l.margin,
      l.ceiling ?? "delete",
      NOW - DAY,
    )
    .run();
}
