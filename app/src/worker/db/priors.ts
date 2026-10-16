import { priorKeyForDomain, priorKeyForSender } from "@clearbox/core";
import type { PriorCounts } from "@clearbox/core";

export interface PriorDeltaEntry {
  accountId: string;
  key: string;
  deletes: number;
  keeps: number;
}

export type PriorDeltaMap = Map<string, PriorDeltaEntry>;

function bump(map: PriorDeltaMap, accountId: string, key: string, delta: PriorCounts): void {
  const id = `${accountId}\u001f${key}`;
  const entry = map.get(id) ?? { accountId, key, deletes: 0, keeps: 0 };
  entry.deletes += delta.deletes;
  entry.keeps += delta.keeps;
  map.set(id, entry);
}

/** Applies one owner decision delta to the sender key and the domain key (skipping unknown ones). */
export function addPriorDelta(
  map: PriorDeltaMap,
  accountId: string,
  sender: string,
  domain: string,
  delta: PriorCounts,
): void {
  if (sender !== "") bump(map, accountId, priorKeyForSender(sender), delta);
  if (domain !== "") bump(map, accountId, priorKeyForDomain(domain), delta);
}

/** Upsert with clamping at zero; negative deltas come from undo. */
export function priorUpsertStmt(
  db: D1Database,
  accountId: string,
  key: string,
  delta: PriorCounts,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at)
       VALUES (?1, ?2, MAX(0, ?3), MAX(0, ?4), ?5)
       ON CONFLICT (account_id, key) DO UPDATE SET
         deletes = MAX(0, sender_priors.deletes + ?3),
         keeps = MAX(0, sender_priors.keeps + ?4),
         updated_at = ?5`,
    )
    .bind(accountId, key, delta.deletes, delta.keeps, now);
}

export function priorStatements(db: D1Database, map: PriorDeltaMap, now: number): D1PreparedStatement[] {
  return [...map.values()]
    .filter((e) => e.deletes !== 0 || e.keeps !== 0)
    .map((e) => priorUpsertStmt(db, e.accountId, e.key, { deletes: e.deletes, keeps: e.keeps }, now));
}
