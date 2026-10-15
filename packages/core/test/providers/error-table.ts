import { expect } from "vitest";
import {
  CursorExpiredError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  type ClearboxError,
} from "../../src/model/errors.ts";

/** One row of a JSON error classification table (test/fixtures/{oauth,gmail,graph}/*errors.json). */
export interface ErrorRow {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  expected: keyof typeof ERROR_CLASSES;
  reason?: string;
  retryAfterMs?: number | null;
  retryAfterRange?: [number, number];
  httpStatus?: number;
}

export const ERROR_CLASSES = {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderResponseError,
  CursorExpiredError,
} as const;

export function expectClassified(row: ErrorRow, err: ClearboxError): void {
  expect(err).toBeInstanceOf(ERROR_CLASSES[row.expected]);
  if (row.reason !== undefined) expect(err).toMatchObject({ reason: row.reason });
  if (row.retryAfterMs !== undefined) expect(err).toMatchObject({ retryAfterMs: row.retryAfterMs });
  if (row.retryAfterRange !== undefined) {
    const value = (err as ProviderRateLimitError).retryAfterMs;
    expect(value).toBeGreaterThanOrEqual(row.retryAfterRange[0]);
    expect(value).toBeLessThanOrEqual(row.retryAfterRange[1]);
  }
  if (row.httpStatus !== undefined) expect(err).toMatchObject({ status: row.httpStatus });
}
