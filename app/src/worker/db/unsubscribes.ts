import type { SqlQuery } from "./sql.ts";

/** Contracts 12.8: the newest pending email of one sender in one account (uses suggestions_open). */
export interface NewestPendingRow {
  message_id: number;
  provider_msg_id: string;
  signals_json: string;
}

export function newestPendingFromSenderQuery(accountId: string, sender: string): SqlQuery {
  return {
    sql: `SELECT s.message_id, m.provider_msg_id, m.signals_json
          FROM suggestions s JOIN messages m ON m.id = s.message_id
          WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender = ?2 AND m.account_id = ?1
          ORDER BY m.received_at DESC, s.message_id DESC LIMIT 1`,
    params: [accountId, sender],
  };
}

export function unsubscribedAtQuery(accountId: string, sender: string): SqlQuery {
  return {
    sql: "SELECT unsubscribed_at FROM unsubscribes WHERE account_id = ?1 AND sender = ?2",
    params: [accountId, sender],
  };
}

export function recordUnsubscribeStmt(
  db: D1Database,
  accountId: string,
  sender: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO unsubscribes (account_id, sender, unsubscribed_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (account_id, sender) DO UPDATE SET unsubscribed_at = excluded.unsubscribed_at`,
    )
    .bind(accountId, sender, now);
}

interface StoredUnsubscribeSignals {
  oneClickUnsubscribe?: unknown;
  auth?: { dkim?: unknown } | null;
}

/**
 * RFC 8058 section 4: offer one-click only when the stored signals say List-Unsubscribe-Post is the one-click
 * pair with an https URI, and the receiving provider reported DKIM pass.
 */
export function oneClickOffered(signalsJson: string | null | undefined): boolean {
  if (!signalsJson) return false;
  try {
    const s = JSON.parse(signalsJson) as StoredUnsubscribeSignals | null;
    return s?.oneClickUnsubscribe === true && s.auth?.dkim === "pass";
  } catch {
    return false;
  }
}
