import { priorKeyForDomain, priorKeyForSender } from "@clearbox/core";
import type { PriorCounts } from "@clearbox/core";
import { chunk } from "../db/sql.ts";
import type { FreshKeys, LabelRow, PageContext, RedecideRow } from "./ingest.ts";
import { IN_LIST_MAX, numbered, rowsOf, stmt } from "./write-plan.ts";
import type { BatchResult, SqlValue, Stmt } from "./write-plan.ts";

export type ContextTag =
  | "known"
  | "priors"
  | "senders"
  | "correspondents"
  | "threads"
  | "labels_sender"
  | "labels_domain"
  | "redecide";

export interface TaggedStmt {
  tag: ContextTag;
  stmt: Stmt;
}

const LABEL_COLUMNS = "id, sender, sender_domain, subject_trunc, owner_action";

function labelsSql(partition: "sender" | "sender_domain", inClause: string): string {
  return `SELECT ${LABEL_COLUMNS} FROM (
    SELECT ${LABEL_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY id DESC) AS rn
    FROM labels WHERE account_id = ?1 AND ${partition} IN (${inClause})
  ) WHERE rn <= 5`;
}

function inList(
  tag: ContextTag,
  build: (placeholders: string) => string,
  accountId: string,
  values: readonly string[],
): TaggedStmt[] {
  if (values.length === 0) return [];
  return chunk(values, IN_LIST_MAX).map((c) => ({
    tag,
    stmt: stmt(build(numbered(2, c.length)), accountId, ...(c as SqlValue[])),
  }));
}

export function freshContextStatements(accountId: string, keys: FreshKeys): TaggedStmt[] {
  const priorKeys = [...keys.senders.map(priorKeyForSender), ...keys.domains.map(priorKeyForDomain)];
  return [
    ...inList(
      "known",
      (p) => `SELECT provider_msg_id FROM messages WHERE account_id = ?1 AND provider_msg_id IN (${p})`,
      accountId,
      keys.providerIds,
    ),
    ...inList(
      "priors",
      (p) => `SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 AND key IN (${p})`,
      accountId,
      priorKeys,
    ),
    ...inList(
      "senders",
      (p) =>
        `SELECT address, seen_count, read_count FROM senders WHERE account_id = ?1 AND address IN (${p})`,
      accountId,
      keys.senders,
    ),
    ...inList(
      "correspondents",
      (p) => `SELECT address FROM correspondents WHERE account_id = ?1 AND address IN (${p})`,
      accountId,
      keys.senders,
    ),
    ...inList(
      "threads",
      (p) => `SELECT thread_id FROM sent_threads WHERE account_id = ?1 AND thread_id IN (${p})`,
      accountId,
      keys.threadIds,
    ),
    ...inList("labels_sender", (p) => labelsSql("sender", p), accountId, keys.senders),
    ...inList("labels_domain", (p) => labelsSql("sender_domain", p), accountId, keys.domains),
  ];
}

const DUE =
  "s.account_id = ?1 AND s.status = 'awaiting_model' AND (s.retry_after IS NULL OR s.retry_after <= ?2)";

export function redecideContextStatements(accountId: string, now: number, limit: number): TaggedStmt[] {
  return [
    {
      tag: "redecide",
      stmt: stmt(
        `SELECT s.message_id, s.sender, s.sender_domain, s.decision_attempts, m.provider_msg_id, m.thread_id,
           m.internet_message_id, m.sender_name, m.subject, m.snippet, m.received_at, m.is_read, m.signals_json, m.web_link
         FROM suggestions s JOIN messages m ON m.id = s.message_id
         WHERE ${DUE}
         ORDER BY s.created_at LIMIT ?3`,
        accountId,
        now,
        limit,
      ),
    },
    {
      tag: "priors",
      stmt: stmt(
        `SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 AND (
           key IN (SELECT s.sender FROM suggestions s WHERE ${DUE})
           OR key IN (SELECT '@' || s.sender_domain FROM suggestions s WHERE ${DUE}))`,
        accountId,
        now,
      ),
    },
    {
      tag: "labels_sender",
      stmt: stmt(labelsSql("sender", `SELECT s.sender FROM suggestions s WHERE ${DUE}`), accountId, now),
    },
    {
      tag: "labels_domain",
      stmt: stmt(
        labelsSql("sender_domain", `SELECT s.sender_domain FROM suggestions s WHERE ${DUE}`),
        accountId,
        now,
      ),
    },
  ];
}

function push(map: Map<string, LabelRow[]>, key: string, row: LabelRow): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [row]);
  else if (!list.some((l) => l.id === row.id)) list.push(row);
}

export function parseContext(
  tagged: readonly TaggedStmt[],
  results: readonly BatchResult[],
): { ctx: PageContext; redecideRows: RedecideRow[] } {
  const known = new Set<string>();
  const priors = new Map<string, PriorCounts>();
  const senders = new Map<string, { seen: number; read: number }>();
  const correspondents = new Set<string>();
  const repliedThreads = new Set<string>();
  const labelsBySender = new Map<string, LabelRow[]>();
  const labelsByDomain = new Map<string, LabelRow[]>();
  let redecideRows: RedecideRow[] = [];
  tagged.forEach((t, i) => {
    const r = results[i];
    switch (t.tag) {
      case "known":
        for (const row of rowsOf<{ provider_msg_id: string }>(r)) known.add(row.provider_msg_id);
        break;
      case "priors":
        for (const row of rowsOf<{ key: string; deletes: number; keeps: number }>(r)) {
          priors.set(row.key, { deletes: row.deletes, keeps: row.keeps });
        }
        break;
      case "senders":
        for (const row of rowsOf<{ address: string; seen_count: number; read_count: number }>(r)) {
          senders.set(row.address, { seen: row.seen_count, read: row.read_count });
        }
        break;
      case "correspondents":
        for (const row of rowsOf<{ address: string }>(r)) correspondents.add(row.address);
        break;
      case "threads":
        for (const row of rowsOf<{ thread_id: string }>(r)) repliedThreads.add(row.thread_id);
        break;
      case "labels_sender":
        for (const row of rowsOf<LabelRow>(r)) push(labelsBySender, row.sender, row);
        break;
      case "labels_domain":
        for (const row of rowsOf<LabelRow>(r)) push(labelsByDomain, row.sender_domain, row);
        break;
      case "redecide":
        redecideRows = rowsOf<RedecideRow>(r);
        break;
    }
  });
  for (const list of [...labelsBySender.values(), ...labelsByDomain.values()])
    list.sort((a, b) => b.id - a.id);
  return {
    ctx: { known, priors, senders, correspondents, repliedThreads, labelsBySender, labelsByDomain },
    redecideRows,
  };
}
