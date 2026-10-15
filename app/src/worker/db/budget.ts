export interface Budget {
  date: string;
  rowsWritten: number;
  rowsRead: number;
  ticks: number;
  messagesIngested: number;
  decisionCalls: number;
  decisionFailures: number;
  decisionInputTokens: number;
  providerCalls: number;
  dbSizeBytes: number;
  updatedAt: number;
}

export interface BudgetRow {
  date: string;
  rows_written: number;
  rows_read: number;
  ticks: number;
  messages_ingested: number;
  decision_calls: number;
  decision_failures: number;
  decision_input_tokens: number;
  provider_calls: number;
  db_size_bytes: number;
  updated_at: number;
}

export interface BudgetDelta {
  rowsWritten?: number;
  rowsRead?: number;
  ticks?: number;
  messagesIngested?: number;
  decisionCalls?: number;
  decisionFailures?: number;
  decisionInputTokens?: number;
  providerCalls?: number;
  /** Absolute value (from D1 meta.size_after); null or absent keeps the stored value. */
  dbSizeBytes?: number | null;
}

export function mapBudget(row: BudgetRow | null, date: string): Budget {
  if (!row) {
    return {
      date,
      rowsWritten: 0,
      rowsRead: 0,
      ticks: 0,
      messagesIngested: 0,
      decisionCalls: 0,
      decisionFailures: 0,
      decisionInputTokens: 0,
      providerCalls: 0,
      dbSizeBytes: 0,
      updatedAt: 0,
    };
  }
  return {
    date: row.date,
    rowsWritten: row.rows_written,
    rowsRead: row.rows_read,
    ticks: row.ticks,
    messagesIngested: row.messages_ingested,
    decisionCalls: row.decision_calls,
    decisionFailures: row.decision_failures,
    decisionInputTokens: row.decision_input_tokens,
    providerCalls: row.provider_calls,
    dbSizeBytes: row.db_size_bytes,
    updatedAt: row.updated_at,
  };
}

export function selectBudgetStmt(db: D1Database, date: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM budget WHERE date = ?1").bind(date);
}

export async function readBudget(db: D1Database, date: string): Promise<Budget> {
  return mapBudget(await selectBudgetStmt(db, date).first<BudgetRow>(), date);
}

export function budgetDeltaStmt(
  db: D1Database,
  date: string,
  delta: BudgetDelta,
  now: number,
): D1PreparedStatement {
  const size = delta.dbSizeBytes ?? null;
  return db
    .prepare(
      `INSERT INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
         decision_input_tokens, provider_calls, db_size_bytes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, 0), ?11)
       ON CONFLICT (date) DO UPDATE SET
         rows_written = rows_written + excluded.rows_written,
         rows_read = rows_read + excluded.rows_read,
         ticks = ticks + excluded.ticks,
         messages_ingested = messages_ingested + excluded.messages_ingested,
         decision_calls = decision_calls + excluded.decision_calls,
         decision_failures = decision_failures + excluded.decision_failures,
         decision_input_tokens = decision_input_tokens + excluded.decision_input_tokens,
         provider_calls = provider_calls + excluded.provider_calls,
         db_size_bytes = CASE WHEN ?10 IS NULL THEN budget.db_size_bytes ELSE excluded.db_size_bytes END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      date,
      delta.rowsWritten ?? 0,
      delta.rowsRead ?? 0,
      delta.ticks ?? 0,
      delta.messagesIngested ?? 0,
      delta.decisionCalls ?? 0,
      delta.decisionFailures ?? 0,
      delta.decisionInputTokens ?? 0,
      delta.providerCalls ?? 0,
      size,
      now,
    );
}

export function selectBudgetHistoryStmt(db: D1Database, fromDate: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM budget WHERE date >= ?1 ORDER BY date").bind(fromDate);
}
