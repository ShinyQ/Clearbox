export interface MessageInsert {
  providerMsgId: string;
  threadId: string | null;
  internetMessageId: string | null;
  /** Lowercased address, "" when unknown. */
  sender: string;
  senderName: string | null;
  senderDomain: string;
  /** At most MESSAGE_SUBJECT_MAX_CHARS. */
  subject: string | null;
  /** null when policy.storeSnippets is false. */
  snippet: string | null;
  receivedAt: number;
  isRead: boolean;
  signalsJson: string;
  webLink: string | null;
  createdAt: number;
}

export function insertMessageStmt(db: D1Database, accountId: string, m: MessageInsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO messages (account_id, provider_msg_id, thread_id, internet_message_id, sender, sender_name,
         sender_domain, subject, snippet, received_at, is_read, signals_json, web_link, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (account_id, provider_msg_id) DO NOTHING`,
    )
    .bind(
      accountId,
      m.providerMsgId,
      m.threadId,
      m.internetMessageId,
      m.sender,
      m.senderName,
      m.senderDomain,
      m.subject,
      m.snippet,
      m.receivedAt,
      m.isRead ? 1 : 0,
      m.signalsJson,
      m.webLink,
      m.createdAt,
    );
}

/**
 * Graph move returns a new immutable id (contracts 7.7). A no-op when another row of the account already holds
 * that id, so a UNIQUE (account_id, provider_msg_id) collision cannot abort the surrounding D1 batch.
 */
export function updateProviderMsgIdStmt(
  db: D1Database,
  accountId: string,
  messageId: number,
  providerMsgId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE messages SET provider_msg_id = ?3 WHERE account_id = ?1 AND id = ?2
         AND NOT EXISTS (SELECT 1 FROM messages WHERE account_id = ?1 AND provider_msg_id = ?3)`,
    )
    .bind(accountId, messageId, providerMsgId);
}
