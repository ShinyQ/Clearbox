export type SqlValue = string | number | null | Uint8Array;

/** A D1 statement as plain data; `tick.ts` binds it with `db.prepare(sql).bind(...params)`. */
export interface Stmt {
  sql: string;
  params: SqlValue[];
}

/** Structural subset of D1Result, so builders and parsers stay free of Workers types. */
export interface BatchResult {
  results?: unknown[];
  meta?: { changes?: number; rows_read?: number; rows_written?: number; size_after?: number };
}

/** Values per IN list; keeps every statement under D1's 100 bound parameters. */
export const IN_LIST_MAX = 90;

export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

/** "?start, ?start+1, ..." for IN lists that follow fixed leading parameters. */
export function numbered(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

export function rowsOf<T>(r: BatchResult | undefined): T[] {
  return (r?.results ?? []) as T[];
}

export function sumMeta(
  results: readonly BatchResult[],
  field: "changes" | "rows_read" | "rows_written",
): number {
  let total = 0;
  for (const r of results) total += r.meta?.[field] ?? 0;
  return total;
}

export function lastSizeAfter(results: readonly BatchResult[]): number {
  for (let i = results.length - 1; i >= 0; i--) {
    const size = results[i]?.meta?.size_after;
    if (typeof size === "number" && size > 0) return size;
  }
  return 0;
}

// Date helpers are plan 03's (db/sql.ts); re-exported so scan and nightly builders import one module.
export { nextUtcMidnight, toIso as isoOf, utcDate } from "../db/sql.ts";
