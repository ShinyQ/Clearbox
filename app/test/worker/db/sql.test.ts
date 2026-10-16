import { createSubrequestCounter } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  chunk,
  decodeCursor,
  encodeCursor,
  isoToMs,
  nextUtcMidnight,
  placeholders,
  sumRowsWritten,
  toIsoOrNull,
  utcDate,
  withCount,
} from "../../../src/worker/db/sql.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";

describe("sql helpers", () => {
  it("chunks and builds numbered placeholders", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(placeholders(3)).toBe("?1, ?2, ?3");
    expect(placeholders(2, 4)).toBe("?4, ?5");
  });

  it("formats UTC dates and the next midnight", () => {
    const t = Date.UTC(2026, 9, 15, 23, 59, 59);
    expect(utcDate(t)).toBe("2026-10-15");
    expect(nextUtcMidnight(t)).toBe(Date.UTC(2026, 9, 16));
    expect(toIsoOrNull(null)).toBeNull();
    expect(isoToMs("2026-10-15T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 15));
  });

  it("round trips cursors and rejects malformed ones with 400", () => {
    const schema = z.strictObject({ v: z.literal(1), id: z.int() });
    expect(decodeCursor(encodeCursor({ v: 1, id: 7 }), schema)).toEqual({ v: 1, id: 7 });
    for (const bad of ["***", encodeCursor({ v: 2, id: 7 }), encodeCursor("text")]) {
      try {
        decodeCursor(bad, schema);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe("validation_failed");
      }
    }
  });

  it("sums rows written from batch metadata", async () => {
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k1', '1', 0)"),
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k2', '2', 0)"),
    ]);
    expect(sumRowsWritten(results)).toBeGreaterThanOrEqual(2);
  });

  it("reserves one subrequest per D1 call", async () => {
    const counter = createSubrequestCounter(1);
    await withCount(counter, () => env.DB.prepare("SELECT 1").run());
    expect(counter.used).toBe(1);
    await expect(withCount(counter, () => env.DB.prepare("SELECT 1").run())).rejects.toMatchObject({
      code: "subrequest_budget",
    });
  });
});
