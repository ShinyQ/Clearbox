import type { SubrequestCounter } from "@clearbox/core";
import { chunk } from "../db/sql.ts";
import { auditStmt, numbered, rowsOf, stmt, sumMeta } from "../scan/write-plan.ts";
import type { BatchResult, Stmt } from "../scan/write-plan.ts";

export type NightlyRunner = (counter: SubrequestCounter, stmts: readonly Stmt[]) => Promise<BatchResult[]>;

export const PURGE_SELECT_LIMIT = 500;
export const PURGE_DELETE_CHUNK = 90;
/** Must equal the LIMIT literal in ACCOUNT_TABLE_DELETES. */
export const ACCOUNT_DELETE_LIMIT = 1000;

export interface PurgeState {
  rounds: number;
  rowsWritten: number;
  rowsRead: number;
  purgedMessages: number;
  purgedAccounts: number;
  stoppedByBudget: boolean;
}

export function newPurgeState(): PurgeState {
  return {
    rounds: 0,
    rowsWritten: 0,
    rowsRead: 0,
    purgedMessages: 0,
    purgedAccounts: 0,
    stoppedByBudget: false,
  };
}

export interface PurgeLimits {
  startRows: number;
  stopRows: number;
  maxRounds: number;
}

/** A round needs at most two D1 calls. */
function canRun(state: PurgeState, limits: PurgeLimits, counter: SubrequestCounter): boolean {
  if (state.rounds >= limits.maxRounds) return false;
  if (counter.limit - counter.used < 2) return false;
  if (limits.startRows + state.rowsWritten >= limits.stopRows) {
    state.stoppedByBudget = true;
    return false;
  }
  return true;
}

function track(state: PurgeState, res: readonly BatchResult[]): void {
  state.rowsWritten += sumMeta(res, "rows_written");
  state.rowsRead += sumMeta(res, "rows_read");
}

// The exemption comment is the last line of each template literal, so it cannot swallow SQL after it.
const EXPIRED_SELECT = `SELECT message_id FROM suggestions WHERE expires_at < ?1 LIMIT ?2
  -- isolation-exempt: purge_expired`;

function expiredDeletes(ids: readonly number[]): Stmt[] {
  const parts = chunk(ids, PURGE_DELETE_CHUNK);
  return [
    ...parts.map((c) =>
      stmt(
        `DELETE FROM suggestions WHERE message_id IN (${numbered(1, c.length)})
  -- isolation-exempt: purge_expired`,
        ...c,
      ),
    ),
    ...parts.map((c) =>
      stmt(
        `DELETE FROM messages WHERE id IN (${numbered(1, c.length)})
  -- isolation-exempt: purge_expired`,
        ...c,
      ),
    ),
  ];
}

/** Contracts 8.6: expired suggestions and their messages, suggestions first (FK). Cross-account by design. */
export async function purgeExpired(
  run: NightlyRunner,
  counter: SubrequestCounter,
  now: number,
  state: PurgeState,
  limits: PurgeLimits,
): Promise<void> {
  while (canRun(state, limits, counter)) {
    const selected = await run(counter, [stmt(EXPIRED_SELECT, now, PURGE_SELECT_LIMIT)]);
    track(state, selected);
    const ids = rowsOf<{ message_id: number }>(selected[0]).map((r) => r.message_id);
    if (ids.length === 0) return;
    state.rounds += 1;
    const deletes = expiredDeletes(ids);
    const res = await run(counter, deletes);
    track(state, res);
    state.purgedMessages += sumMeta(res.slice(deletes.length / 2), "changes");
    if (ids.length < PURGE_SELECT_LIMIT) return;
  }
}

/** Order matters: suggestions before messages (FK), messages only once no suggestion references them. */
const ACCOUNT_TABLE_DELETES: readonly string[] = [
  "DELETE FROM suggestions WHERE rowid IN (SELECT rowid FROM suggestions WHERE account_id = ?1 LIMIT 1000)",
  `DELETE FROM messages WHERE rowid IN (SELECT m.rowid FROM messages m WHERE m.account_id = ?1
     AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.message_id = m.id) LIMIT 1000)`,
  "DELETE FROM labels WHERE rowid IN (SELECT rowid FROM labels WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM sender_priors WHERE account_id = ?1 AND key IN (SELECT key FROM sender_priors WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM senders WHERE account_id = ?1 AND address IN (SELECT address FROM senders WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM correspondents WHERE account_id = ?1 AND address IN (SELECT address FROM correspondents WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM sent_threads WHERE account_id = ?1 AND thread_id IN (SELECT thread_id FROM sent_threads WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM unsubscribes WHERE account_id = ?1 AND sender IN (SELECT sender FROM unsubscribes WHERE account_id = ?1 LIMIT 1000)",
];

/** Contracts 8.6: disconnected accounts, in table order, then the leases and the account row. */
export async function purgeDisconnected(
  run: NightlyRunner,
  counter: SubrequestCounter,
  accountIds: readonly string[],
  now: number,
  state: PurgeState,
  limits: PurgeLimits,
): Promise<void> {
  for (const accountId of accountIds) {
    for (;;) {
      if (!canRun(state, limits, counter)) return;
      state.rounds += 1;
      const res = await run(
        counter,
        ACCOUNT_TABLE_DELETES.map((sql) => stmt(sql, accountId)),
      );
      track(state, res);
      state.purgedMessages += res[1]?.meta?.changes ?? 0;
      if (res.some((r) => (r.meta?.changes ?? 0) >= ACCOUNT_DELETE_LIMIT)) continue;
      const finish = await run(counter, [
        stmt("DELETE FROM leases WHERE account_id = ?1", accountId),
        stmt("DELETE FROM accounts WHERE id = ?1 AND status = 'disconnected'", accountId),
        auditStmt(now, accountId, "account_purged", 1, {}),
      ]);
      track(state, finish);
      state.purgedAccounts += finish[1]?.meta?.changes ?? 0;
      break;
    }
  }
}
