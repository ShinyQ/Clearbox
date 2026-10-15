import { describe, expect, it } from "vitest";
import * as C from "../../src/model/constants.ts";

describe("constants", () => {
  it("match contracts 4.13 for the values core logic depends on", () => {
    expect(C.PRIOR_MIN_N).toBe(3);
    expect(C.PRIOR_LAMBDA_K).toBe(5);
    expect(C.FLAG_THRESHOLD).toBe(0.7);
    expect(C.DELETE_MARGIN).toBe(0.2);
    expect(C.MIN_CONFIDENCE).toBe(0.55);
    expect(C.MAX_REASONS).toBe(3);
    expect([C.TAU_DELETE_DEFAULT, C.TAU_DELETE_MIN, C.TAU_DELETE_MAX, C.TAU_STEP]).toEqual([
      0.8, 0.8, 0.99, 0.01,
    ]);
    expect(C.DECISION_RETRY_DELAYS_MS).toEqual([300_000, 1_800_000]);
    expect(C.DECISION_STATE_MAX_CHARS).toBe(1750);
    expect(C.TICK_SUBREQUEST_LIMIT).toBe(45);
    expect(C.BACKOFF_MAX_MS).toBe(21_600_000);
    expect(C.UNDO_WINDOW_MS).toBe(86_400_000);
  });
});
