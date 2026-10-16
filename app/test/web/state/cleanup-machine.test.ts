import { describe, expect, it } from "vitest";
import type { CleanupPreview } from "../../../src/shared/api.ts";
import { emptyTotals } from "../../../src/web/api/cleanup.ts";
import {
  cleanupReducer,
  INITIAL_CLEANUP,
  type CleanupEvent,
  type CleanupState,
} from "../../../src/web/state/cleanup-machine.ts";

const preview = (count: number): CleanupPreview => ({
  asOf: "2026-10-15T10:00:00.000Z",
  threshold: 0.86,
  defaultThreshold: 0.86,
  count,
  byAction: { delete: count, archive: 0, keep: 0 },
  groups: 2,
  groupsLeft: 1,
});
const run = (events: CleanupEvent[], from: CleanupState = INITIAL_CLEANUP) =>
  events.reduce(cleanupReducer, from);

describe("cleanupReducer (UI spec 5.2.2)", () => {
  it("goes idle, preparing, confirming, running, done, idle", () => {
    let s = run([{ type: "START", mode: "cleanup", accountId: null }]);
    expect(s.machine.phase).toBe("preparing");
    s = run([{ type: "PREVIEW_OK", preview: preview(14) }], s);
    expect(s.machine.phase).toBe("confirming");
    s = run([{ type: "CONFIRM" }], s);
    expect(s.machine).toMatchObject({ phase: "running", stopRequested: false, run: { total: 14 } });
    s = run([{ type: "PROGRESS", run: { ...emptyTotals(14), executed: 10 } }], s);
    expect(s.machine).toMatchObject({ phase: "running", run: { executed: 10 } });
    s = run([{ type: "FINISH", outcome: { phase: "done", run: { ...emptyTotals(14), executed: 14 } } }], s);
    expect(s.machine.phase).toBe("done");
    expect(run([{ type: "SETTLE" }], s).machine.phase).toBe("idle");
  });

  it("returns to idle when the fresh preview is empty, and to error when it fails", () => {
    const preparing = run([{ type: "START", mode: "cleanup", accountId: "acc_1" }]);
    expect(preparing.accountId).toBe("acc_1");
    expect(run([{ type: "PREVIEW_OK", preview: preview(0) }], preparing).machine.phase).toBe("idle");
    const error = run([{ type: "PREVIEW_FAIL", code: "network" }], preparing);
    expect(error.machine).toEqual({ phase: "error", code: "network" });
    expect(run([{ type: "SETTLE" }], error).machine.phase).toBe("idle");
  });

  it("cancels from confirming and records Stop while running", () => {
    const confirming = run([
      { type: "START", mode: "confirm_keeps", accountId: null },
      { type: "PREVIEW_OK", preview: preview(3) },
    ]);
    expect(confirming.mode).toBe("confirm_keeps");
    expect(run([{ type: "CANCEL" }], confirming).machine.phase).toBe("idle");
    const stopping = run([{ type: "CONFIRM" }, { type: "STOP" }], confirming);
    expect(stopping.machine).toMatchObject({ phase: "running", stopRequested: true });
  });

  it("handles partial: Try again re-prepares, Dismiss returns to idle", () => {
    const partial = run([
      { type: "START", mode: "cleanup", accountId: null },
      { type: "PREVIEW_OK", preview: preview(200) },
      { type: "CONFIRM" },
      {
        type: "FINISH",
        outcome: { phase: "partial", reason: "budget", run: { ...emptyTotals(200), executed: 100 } },
      },
    ]);
    expect(partial.machine).toMatchObject({ phase: "partial", reason: "budget" });
    expect(run([{ type: "RETRY" }], partial).machine.phase).toBe("preparing");
    expect(run([{ type: "DISMISS" }], partial).machine.phase).toBe("idle");
  });

  it("ignores events that do not apply to the current phase", () => {
    expect(run([{ type: "CONFIRM" }, { type: "STOP" }, { type: "DISMISS" }])).toEqual(INITIAL_CLEANUP);
    const preparing = run([{ type: "START", mode: "cleanup", accountId: null }]);
    expect(run([{ type: "START", mode: "confirm_keeps", accountId: null }], preparing)).toEqual(preparing);
  });
});
