import type { SubrequestCounter } from "@clearbox/core";
import type { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import { ApiError } from "../middleware/errors.ts";

/** D1 allows 100 bound parameters per statement; stay at 99 or fewer. */
export const MAX_BOUND_PARAMS = 99;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A statement whose SQL text is inspectable (query plan tests) before binding. */
export interface SqlQuery {
  sql: string;
  params: unknown[];
}

export function bindQuery(db: D1Database, q: SqlQuery): D1PreparedStatement {
  return db.prepare(q.sql).bind(...q.params);
}

/** "?start, ?start+1, ..." for numbered parameters. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

export function sumRowsWritten(results: readonly D1Result[]): number {
  return results.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0);
}

export function sumRowsRead(results: readonly D1Result[]): number {
  return results.reduce((sum, r) => sum + (r.meta.rows_read ?? 0), 0);
}

export function now(): number {
  return Date.now();
}

/** Every D1 call reserves one subrequest from the tick counter (contracts 8.4). */
export async function withCount<T>(counter: SubrequestCounter, fn: () => Promise<T>): Promise<T> {
  counter.reserve(1);
  return fn();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

export function utcDate(ms: number): string {
  return toIso(ms).slice(0, 10);
}

export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** SQLite booleans are 0/1 integers. */
export function flag(value: unknown): boolean {
  return value === 1 || value === true;
}

export function encodeCursor(value: unknown): string {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(base64UrlToBytes(cursor)));
  } catch {
    throw new ApiError(400, "validation_failed", "Malformed cursor");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "validation_failed", "Malformed cursor");
  return parsed.data;
}
