import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../model/constants.ts";
import { SubrequestBudgetError } from "../model/errors.ts";

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface SubrequestCounter {
  readonly used: number;
  readonly limit: number;
  /** Throws SubrequestBudgetError (extends ClearboxError, code "subrequest_budget") when used + n > limit. */
  reserve(n?: number): void;
}

export function createSubrequestCounter(limit: number, alreadyUsed = 0): SubrequestCounter {
  let used = alreadyUsed;
  return {
    get used() {
      return used;
    },
    limit,
    reserve(n = 1) {
      if (used + n > limit) {
        throw new SubrequestBudgetError({ used, limit });
      }
      used += n;
    },
  };
}

/** Wraps fetch: every call reserves 1 from the counter first. */
export function countingFetch(base: FetchLike, counter: SubrequestCounter): FetchLike {
  return (input, init) => {
    try {
      counter.reserve(1);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return base(input, init);
  };
}

/** Retry-After: delta-seconds or HTTP date; also accepts retry-after-ms (preferred). Returns ms (>= 0) or null. */
export function parseRetryAfter(headers: Headers, now: number): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\s*\d+(\.\d+)?\s*$/.test(ms)) {
    return Math.max(0, Math.round(Number(ms)));
  }
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^(attempt-1)) + jitter(0..1000 ms); attempt >= 1. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  return base + Math.floor(random() * 1000);
}
