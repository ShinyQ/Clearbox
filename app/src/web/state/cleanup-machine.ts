import type { CleanupPreview } from "../../shared/api.ts";
import { emptyTotals, type PartialReason, type RunOutcome, type RunTotals } from "../api/cleanup.ts";
import type { CleanupMode } from "../lib/copy.ts";

/** UI spec 5.2.2 without undoing/undone (decision W22). */
export type CleanupPhase =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "confirming"; preview: CleanupPreview }
  | { phase: "running"; preview: CleanupPreview; run: RunTotals; stopRequested: boolean }
  | { phase: "done"; preview: CleanupPreview; run: RunTotals }
  | { phase: "partial"; preview: CleanupPreview; run: RunTotals; reason: PartialReason }
  | { phase: "error"; code: string };

export interface CleanupState {
  mode: CleanupMode;
  accountId: string | null;
  machine: CleanupPhase;
}

export type CleanupEvent =
  | { type: "START"; mode: CleanupMode; accountId: string | null }
  | { type: "PREVIEW_OK"; preview: CleanupPreview }
  | { type: "PREVIEW_FAIL"; code: string }
  | { type: "CANCEL" }
  | { type: "CONFIRM" }
  | { type: "PROGRESS"; run: RunTotals }
  | { type: "STOP" }
  | { type: "FINISH"; outcome: RunOutcome }
  | { type: "RETRY" }
  | { type: "DISMISS" }
  | { type: "SETTLE" };

export const INITIAL_CLEANUP: CleanupState = { mode: "cleanup", accountId: null, machine: { phase: "idle" } };

export function cleanupReducer(state: CleanupState, event: CleanupEvent): CleanupState {
  const m = state.machine;
  const to = (machine: CleanupPhase): CleanupState => ({ ...state, machine });
  switch (event.type) {
    case "START":
      return m.phase === "idle"
        ? { mode: event.mode, accountId: event.accountId, machine: { phase: "preparing" } }
        : state;
    case "PREVIEW_OK":
      if (m.phase !== "preparing") return state;
      return to(
        event.preview.count > 0 ? { phase: "confirming", preview: event.preview } : { phase: "idle" },
      );
    case "PREVIEW_FAIL":
      return m.phase === "preparing" ? to({ phase: "error", code: event.code }) : state;
    case "CANCEL":
      return m.phase === "confirming" ? to({ phase: "idle" }) : state;
    case "CONFIRM":
      return m.phase === "confirming"
        ? to({
            phase: "running",
            preview: m.preview,
            run: emptyTotals(m.preview.count),
            stopRequested: false,
          })
        : state;
    case "PROGRESS":
      return m.phase === "running" ? to({ ...m, run: event.run }) : state;
    case "STOP":
      return m.phase === "running" ? to({ ...m, stopRequested: true }) : state;
    case "FINISH":
      if (m.phase !== "running") return state;
      return to(
        event.outcome.phase === "done"
          ? { phase: "done", preview: m.preview, run: event.outcome.run }
          : { phase: "partial", preview: m.preview, run: event.outcome.run, reason: event.outcome.reason },
      );
    case "RETRY":
      return m.phase === "partial" ? to({ phase: "preparing" }) : state;
    case "DISMISS":
      return m.phase === "partial" ? to({ phase: "idle" }) : state;
    case "SETTLE":
      return m.phase === "done" || m.phase === "error" ? to({ phase: "idle" }) : state;
  }
}

export const barVisible = (s: CleanupState): boolean =>
  s.machine.phase === "confirming" || s.machine.phase === "running" || s.machine.phase === "partial";
