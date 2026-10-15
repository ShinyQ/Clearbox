import { DECIDED_TTL_MS, SUGGESTED_ACTIONS } from "@clearbox/core";
import type { Ceiling, SuggestedAction } from "@clearbox/core";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import type { OpenCounts } from "./accounts.ts";
import { placeholders } from "./sql.ts";

export interface SuggestionInsert {
  sender: string;
  senderDomain: string;
  status: "awaiting_model" | "pending";
  action: SuggestedAction | null;
  confidence: number | null;
  pDelete: number | null;
  pArchive: number | null;
  pKeep: number | null;
  pUnsure: number | null;
  modelPDelete: number | null;
  margin: number | null;
  importance: number | null;
  flagsJson: string | null;
  ceiling: Ceiling;
  ceilingApplied: boolean;
  reasonsJson: string;
  modelVersion: string | null;
  policyVersion: number;
  decisionAttempts: number;
  retryAfter: number | null;
  createdAt: number;
  expiresAt: number;
}

/** Contracts 8.2: suggestion row keyed by the message id of (account, provider id). */
export function insertSuggestionStmt(
  db: D1Database,
  accountId: string,
  providerMsgId: string,
  s: SuggestionInsert,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, p_delete,
         p_archive, p_keep, p_unsure, model_p_delete, margin, importance, flags_json, ceiling, ceiling_applied,
         reasons_json, model_version, policy_version, decision_attempts, retry_after, created_at, updated_at, expires_at)
       SELECT id, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23, ?24
       FROM messages WHERE account_id = ?1 AND provider_msg_id = ?2
       ON CONFLICT (message_id) DO NOTHING`,
    )
    .bind(
      accountId,
      providerMsgId,
      s.sender,
      s.senderDomain,
      s.status,
      s.action,
      s.confidence,
      s.pDelete,
      s.pArchive,
      s.pKeep,
      s.pUnsure,
      s.modelPDelete,
      s.margin,
      s.importance,
      s.flagsJson,
      s.ceiling,
      s.ceilingApplied ? 1 : 0,
      s.reasonsJson,
      s.modelVersion,
      s.policyVersion,
      s.decisionAttempts,
      s.retryAfter,
      s.createdAt,
      s.expiresAt,
    );
}

export function countOpenByAccountStmt(db: D1Database, accountIds: readonly string[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT account_id, SUM(status = 'pending') AS pending, SUM(status = 'awaiting_model') AS awaiting
       FROM suggestions
       WHERE account_id IN (${placeholders(accountIds.length)}) AND (status = 'pending' OR status = 'awaiting_model')
       GROUP BY account_id`,
    )
    .bind(...accountIds);
}

export async function countOpenByAccount(
  db: D1Database,
  accountIds: readonly string[],
): Promise<Map<string, OpenCounts>> {
  const out = new Map<string, OpenCounts>(accountIds.map((id) => [id, { pending: 0, awaitingModel: 0 }]));
  if (accountIds.length === 0) return out;
  const res = await countOpenByAccountStmt(db, accountIds).run<{
    account_id: string;
    pending: number;
    awaiting: number;
  }>();
  for (const r of res.results) out.set(r.account_id, { pending: r.pending, awaitingModel: r.awaiting });
  return out;
}

/**
 * Disconnect: every open suggestion of the account becomes dismissed (contracts 7.5).
 * awaiting_model rows have no action; the schema CHECK requires one outside awaiting_model, so they get 'unsure'.
 */
export function dismissOpenStmt(db: D1Database, accountId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE suggestions SET status = 'dismissed', action = COALESCE(action, 'unsure'), updated_at = ?2,
         expires_at = ?2 + ?3
       WHERE account_id = ?1 AND (status = 'pending' OR status = 'awaiting_model')`,
    )
    .bind(accountId, now, DECIDED_TTL_MS);
}

const GroupKeySchema = z.tuple([
  z.string().regex(/^acc_[0-9a-f]{16}$/),
  z.string().max(320),
  z.enum(SUGGESTED_ACTIONS),
]);

/** Contracts 7.6: base64url(JSON.stringify([accountId, sender, action])). */
export function encodeGroupKey(accountId: string, sender: string, action: SuggestedAction): string {
  return bytesToBase64Url(utf8(JSON.stringify([accountId, sender, action])));
}

export function decodeGroupKey(
  key: string,
): { accountId: string; sender: string; action: SuggestedAction } | null {
  try {
    const parsed = GroupKeySchema.safeParse(JSON.parse(fromUtf8(base64UrlToBytes(key))));
    if (!parsed.success) return null;
    const [accountId, sender, action] = parsed.data;
    return { accountId, sender, action };
  } catch {
    return null;
  }
}
