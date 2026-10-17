import type { Ceiling, DecisionSegment, SuggestedAction } from "@clearbox/core";
import { placeholders } from "./sql.ts";
import type { SqlQuery } from "./sql.ts";

/**
 * contracts 12.10: pending suggestions to re-fuse. Only rows with a stored model output (model_action_json) qualify;
 * keyset paging on message_id. `senders` / `domains` narrow the scope (an empty pair means every pending row).
 */
export interface RefreshFilter {
  senders: readonly string[];
  domains: readonly string[];
  afterId: number;
  limit: number;
}

export interface RefreshRow {
  message_id: number;
  sender: string;
  sender_domain: string;
  action: SuggestedAction;
  confidence: number | null;
  p_delete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  ceiling_applied: number;
  reasons_json: string;
  segment: DecisionSegment | null;
  delete_tau: number | null;
  model_action_json: string;
  flags_json: string | null;
  importance: number | null;
  model_version: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  signals_json: string;
}

/** Conditions after `s.account_id = ?1`; params must start with [accountId]. */
function where(f: RefreshFilter, params: unknown[]): string {
  params.push(f.afterId);
  const parts = [
    "s.status = 'pending'",
    "s.model_action_json IS NOT NULL",
    `s.message_id > ?${params.length}`,
  ];
  const scope: string[] = [];
  if (f.senders.length > 0) {
    const start = params.length + 1;
    params.push(...f.senders);
    scope.push(`s.sender IN (${placeholders(f.senders.length, start)})`);
  }
  if (f.domains.length > 0) {
    const start = params.length + 1;
    params.push(...f.domains);
    scope.push(`s.sender_domain IN (${placeholders(f.domains.length, start)})`);
  }
  if (scope.length > 0) parts.push(`(${scope.join(" OR ")})`);
  return parts.join(" AND ");
}

export function refreshRowsQuery(accountId: string, f: RefreshFilter): SqlQuery {
  const params: unknown[] = [accountId];
  const w = where(f, params);
  params.push(f.limit);
  const sql = `SELECT s.message_id, s.sender, s.sender_domain, s.action, s.confidence, s.p_delete, s.margin, s.ceiling,
      s.ceiling_applied, s.reasons_json, s.segment, s.delete_tau, s.model_action_json, s.flags_json, s.importance,
      s.model_version, m.subject, m.snippet, m.received_at, m.signals_json
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id = ?1 AND ${w}
    ORDER BY s.message_id LIMIT ?${params.length}`;
  return { sql, params };
}

/** Priors for exactly the rows refreshRowsQuery returns (same filter and limit). */
export function refreshPriorsQuery(accountId: string, f: RefreshFilter): SqlQuery {
  const params: unknown[] = [accountId];
  const w = where(f, params);
  params.push(f.limit);
  const rows = `SELECT s.sender, s.sender_domain FROM suggestions s
    WHERE s.account_id = ?1 AND ${w} ORDER BY s.message_id LIMIT ?${params.length}`;
  const sql = `SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 AND (
      key IN (SELECT r.sender FROM (${rows}) r) OR key IN (SELECT '@' || r.sender_domain FROM (${rows}) r))`;
  return { sql, params };
}

export interface RefreshUpdate {
  messageId: number;
  action: SuggestedAction;
  confidence: number;
  pDelete: number | null;
  pArchive: number | null;
  pKeep: number | null;
  pUnsure: number | null;
  margin: number | null;
  ceiling: Ceiling;
  ceilingApplied: boolean;
  reasonsJson: string;
  segment: DecisionSegment;
  deleteTau: number | null;
}

/** Only a row that is still pending changes (an owner action may have claimed it meanwhile). */
export function refreshUpdateQuery(accountId: string, u: RefreshUpdate, now: number): SqlQuery {
  const sql = `UPDATE suggestions SET action = ?3, confidence = ?4, p_delete = ?5, p_archive = ?6, p_keep = ?7,
      p_unsure = ?8, margin = ?9, ceiling = ?10, ceiling_applied = ?11, reasons_json = ?12, segment = ?13,
      delete_tau = ?14, updated_at = ?15
    WHERE account_id = ?1 AND message_id = ?2 AND status = 'pending'`;
  return {
    sql,
    params: [
      accountId,
      u.messageId,
      u.action,
      u.confidence,
      u.pDelete,
      u.pArchive,
      u.pKeep,
      u.pUnsure,
      u.margin,
      u.ceiling,
      u.ceilingApplied ? 1 : 0,
      u.reasonsJson,
      u.segment,
      u.deleteTau,
      now,
    ],
  };
}
