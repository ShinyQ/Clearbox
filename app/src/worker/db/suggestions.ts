import { DECIDED_TTL_MS, SUGGESTED_ACTIONS } from "@clearbox/core";
import type { ActionKind, Ceiling, SuggestedAction } from "@clearbox/core";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import type { OpenCounts } from "./accounts.ts";
import { placeholders } from "./sql.ts";
import type { SqlQuery } from "./sql.ts";

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

// Queue queries (contracts 7.6). Every one filters account_id and status = 'pending' (or 'awaiting_model') as an
// equality so SQLite uses the suggestions_open partial index.

export type GroupSort = "confidence_desc" | "count_desc" | "newest";

export interface GroupFilter {
  action: SuggestedAction | null;
  minConfidence: number | null;
  sender: string | null;
}

export interface GroupKeyset {
  /** Sort value of the last row on the previous page. */
  k: number;
  a: string;
  s: string;
  x: SuggestedAction;
}

export interface GroupRow {
  account_id: string;
  sender: string;
  action: SuggestedAction;
  n: number;
  cmin: number;
  cavg: number;
  cmax: number;
  capped: number;
  domain: string;
  newest: number;
  oldest: number;
  /** printf('%015d', received_at) || json_array(sender_name, subject) of the newest item. */
  latest: string;
}

const SORT_EXPR: Readonly<Record<GroupSort, string>> = {
  confidence_desc: "AVG(COALESCE(s.confidence, 0))",
  count_desc: "COUNT(*)",
  newest: "MAX(m.received_at)",
};

export function groupSortValue(row: GroupRow, sort: GroupSort): number {
  return sort === "confidence_desc" ? row.cavg : sort === "count_desc" ? row.n : row.newest;
}

export function parseLatest(latest: string): { name: string | null; subject: string | null } {
  const [name, subject] = JSON.parse(latest.slice(15)) as [string | null, string | null];
  return { name: name === "" ? null : name, subject };
}

export function groupsQuery(
  accountIds: readonly string[],
  filter: GroupFilter,
  sort: GroupSort,
  after: GroupKeyset | null,
  limit: number,
): SqlQuery {
  const params: unknown[] = [...accountIds];
  const bind = (value: unknown) => {
    params.push(value);
    return `?${params.length}`;
  };
  const extra: string[] = [];
  if (filter.action !== null) extra.push(`AND s.action = ${bind(filter.action)}`);
  if (filter.minConfidence !== null) extra.push(`AND s.confidence >= ${bind(filter.minConfidence)}`);
  if (filter.sender !== null) extra.push(`AND s.sender = ${bind(filter.sender)}`);
  const expr = SORT_EXPR[sort];
  let having = "";
  if (after) {
    const k = bind(after.k);
    having = `HAVING ${expr} < ${k} OR (${expr} = ${k} AND (s.account_id, s.sender, s.action) > (${bind(after.a)}, ${bind(after.s)}, ${bind(after.x)}))`;
  }
  const lim = bind(limit);
  const sql = `SELECT s.account_id AS account_id, s.sender AS sender, s.action AS action, COUNT(*) AS n,
      MIN(COALESCE(s.confidence, 0)) AS cmin, AVG(COALESCE(s.confidence, 0)) AS cavg, MAX(COALESCE(s.confidence, 0)) AS cmax,
      MAX(s.ceiling_applied) AS capped, MIN(s.sender_domain) AS domain,
      MAX(m.received_at) AS newest, MIN(m.received_at) AS oldest,
      MAX(printf('%015d', m.received_at) || json_array(m.sender_name, m.subject)) AS latest
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id IN (${placeholders(accountIds.length)}) AND s.status = 'pending' ${extra.join(" ")}
    GROUP BY s.account_id, s.sender, s.action
    ${having}
    ORDER BY ${expr} DESC, s.account_id, s.sender, s.action
    LIMIT ${lim}`;
  return { sql, params };
}

export interface ReasonCountRow {
  sender: string;
  action: SuggestedAction;
  code: string;
  n: number;
  reason_json: string;
}

export function groupReasonsQuery(
  accountId: string,
  senders: readonly string[],
  action: SuggestedAction | null,
): SqlQuery {
  const n = senders.length;
  const sql = `SELECT s.sender AS sender, s.action AS action, json_extract(r.value, '$.code') AS code, COUNT(*) AS n,
      MIN(r.value) AS reason_json
    FROM suggestions s, json_each(s.reasons_json) r
    WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender IN (${placeholders(n, 2)})
      AND (?${n + 2} IS NULL OR s.action = ?${n + 2})
    GROUP BY s.sender, s.action, code`;
  return { sql, params: [accountId, ...senders, action] };
}

export function pendingByActionQuery(accountIds: readonly string[]): SqlQuery {
  const sql = `SELECT action, COUNT(*) AS n, COUNT(DISTINCT account_id || char(31) || sender) AS g
    FROM suggestions WHERE account_id IN (${placeholders(accountIds.length)}) AND status = 'pending'
    GROUP BY action`;
  return { sql, params: [...accountIds] };
}

export function awaitingCountQuery(accountIds: readonly string[]): SqlQuery {
  const sql = `SELECT COUNT(*) AS n FROM suggestions
    WHERE account_id IN (${placeholders(accountIds.length)}) AND status = 'awaiting_model'`;
  return { sql, params: [...accountIds] };
}

export function cleanupCountsQuery(
  accountIds: readonly string[],
  actions: readonly ActionKind[],
  threshold: number,
): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT action, COUNT(*) AS n, COUNT(DISTINCT account_id || char(31) || sender) AS g
    FROM suggestions
    WHERE account_id IN (${placeholders(a)}) AND status = 'pending'
      AND action IN (${placeholders(actions.length, a + 1)}) AND confidence >= ?${a + actions.length + 1}
    GROUP BY action`;
  return { sql, params: [...accountIds, ...actions, threshold] };
}

/** Contracts 12.1 A2: pending groups that keep at least one item this Clean up would not take. */
export function groupsLeftQuery(
  accountIds: readonly string[],
  actions: readonly ActionKind[],
  threshold: number,
): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM suggestions
      WHERE account_id IN (${placeholders(a)}) AND status = 'pending'
        AND NOT (action IN (${placeholders(actions.length, a + 1)}) AND COALESCE(confidence, 0) >= ?${a + actions.length + 1})
      GROUP BY account_id, sender, action
    )`;
  return { sql, params: [...accountIds, ...actions, threshold] };
}

export interface ItemKeyset {
  c: number;
  r: number;
  i: number;
}

export interface GroupItemRow {
  message_id: number;
  account_id: string;
  status: "pending";
  action: SuggestedAction;
  confidence: number | null;
  p_delete: number | null;
  p_archive: number | null;
  p_keep: number | null;
  p_unsure: number | null;
  importance: number | null;
  ceiling: "keep" | "archive" | "delete";
  ceiling_applied: number;
  reasons_json: string;
  model_version: string | null;
  policy_version: number;
  provider_msg_id: string;
  sender: string;
  sender_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  is_read: number;
  signals_json: string;
  web_link: string | null;
}

export function groupItemsQuery(
  accountId: string,
  sender: string,
  action: SuggestedAction,
  after: ItemKeyset | null,
  limit: number,
): SqlQuery {
  const keyset = after
    ? `AND (COALESCE(s.confidence, 0) < ?4 OR (COALESCE(s.confidence, 0) = ?4
         AND (m.received_at < ?5 OR (m.received_at = ?5 AND s.message_id < ?6))))`
    : "AND ?4 IS NULL AND ?5 IS NULL AND ?6 IS NULL";
  const sql = `SELECT s.message_id, s.account_id, s.status, s.action, s.confidence, s.p_delete, s.p_archive, s.p_keep,
      s.p_unsure, s.importance, s.ceiling, s.ceiling_applied, s.reasons_json, s.model_version, s.policy_version,
      m.provider_msg_id, m.sender, m.sender_name, m.subject, m.snippet, m.received_at, m.is_read, m.signals_json, m.web_link
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender = ?2 AND s.action = ?3 ${keyset}
    ORDER BY COALESCE(s.confidence, 0) DESC, m.received_at DESC, s.message_id DESC
    LIMIT ?7`;
  return {
    sql,
    params: [accountId, sender, action, after?.c ?? null, after?.r ?? null, after?.i ?? null, limit],
  };
}
