import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { emptyTotals, processedOf, runCleanup } from "../api/cleanup.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { doneToast, partialToast, type CleanupMode } from "../lib/copy.ts";
import { plural } from "../lib/format.ts";
import { barVisible, cleanupReducer, INITIAL_CLEANUP, type CleanupState } from "./cleanup-machine.ts";
import { useAnnounce } from "./LiveAnnouncer.tsx";
import { useToast } from "./ToastProvider.tsx";
import { useUndoStack } from "./UndoStackProvider.tsx";

export interface CleanupApi {
  state: CleanupState;
  start(mode: CleanupMode, accountId?: string): void;
  confirm(): void;
  cancel(): void;
  stop(): void;
  retry(): void;
  dismiss(): void;
  barVisible: boolean;
  progressLabel: string | null;
  busyPhase: "idle" | "preparing" | "busy";
}

const Ctx = createContext<CleanupApi | null>(null);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const percentOf = (run: { executed: number; failed: number; skipped: number; total: number }) =>
  Math.floor((processedOf(run) / Math.max(1, run.total)) * 100);

export function CleanupProvider({
  children,
  sleep = defaultSleep,
}: {
  children: ReactNode;
  sleep?: (ms: number) => Promise<void>;
}) {
  const [state, dispatch] = useReducer(cleanupReducer, INITIAL_CLEANUP);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const qc = useQueryClient();
  const toast = useToast();
  const announce = useAnnounce();
  const undoStack = useUndoStack();
  const signal = useRef({ stop: false });
  const announced = useRef(0);
  // Lets fetchPreview's "Try again" toast call the latest start() without a declaration cycle.
  const startRef = useRef<(mode: CleanupMode, accountId?: string) => void>(() => undefined);

  const fetchPreview = useCallback(
    async (mode: CleanupMode, accountId: string | null) => {
      const scope = accountId ?? undefined;
      try {
        const preview = await api.cleanupPreview(
          mode === "confirm_keeps"
            ? { actions: "keep", threshold: 0.5, accountId: scope }
            : { actions: "delete,archive", accountId: scope },
        );
        dispatch({ type: "PREVIEW_OK", preview });
        if (preview.count === 0) {
          toast.show({
            kind: "info",
            message: "Nothing left to clean up. New suggestions appear after the next sort.",
          });
          void qc.invalidateQueries({ queryKey: ["queue"] });
          void qc.invalidateQueries({ queryKey: ["groups"] });
        }
      } catch {
        dispatch({ type: "PREVIEW_FAIL", code: "network" });
        toast.show({
          kind: "error",
          message: "Couldn't prepare Clean up. Nothing was changed.",
          action: { label: "Try again", onAction: () => startRef.current(mode, scope) },
        });
        dispatch({ type: "SETTLE" });
      }
    },
    [qc, toast],
  );

  const start = useCallback(
    (mode: CleanupMode, accountId?: string) => {
      if (stateRef.current.machine.phase !== "idle") return;
      dispatch({ type: "START", mode, accountId: accountId ?? null });
      stateRef.current = { mode, accountId: accountId ?? null, machine: { phase: "preparing" } };
      void fetchPreview(mode, accountId ?? null);
    },
    [fetchPreview],
  );
  useEffect(() => {
    startRef.current = start;
  });

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (s.machine.phase !== "confirming") return;
    const { preview } = s.machine;
    const mode = s.mode;
    dispatch({ type: "CONFIRM" });
    // Guard against a second confirm (Enter plus click) before the next render.
    stateRef.current = {
      ...s,
      machine: { phase: "running", preview, run: emptyTotals(preview.count), stopRequested: false },
    };
    signal.current = { stop: false };
    announced.current = 0;
    announce(
      `${mode === "confirm_keeps" ? "Confirming keeps" : "Clean up started"}, ${plural(preview.count, "email", "emails")}`,
    );
    void runCleanup(
      preview,
      {
        actions: mode === "confirm_keeps" ? ["keep"] : ["delete", "archive"],
        accountId: s.accountId ?? undefined,
      },
      {
        post: api.cleanup,
        sleep,
        signal: signal.current,
        onProgress: (run) => {
          dispatch({ type: "PROGRESS", run });
          const pct = percentOf(run);
          const step = [75, 50, 25].find((t) => pct >= t && announced.current < t);
          if (step && pct < 100) {
            announced.current = step;
            announce(
              `${mode === "confirm_keeps" ? "Confirming keeps" : "Cleaning up"}, ${step} percent done`,
            );
          }
        },
      },
    ).then((outcome) => {
      dispatch({ type: "FINISH", outcome });
      const kind = mode === "confirm_keeps" ? "action" : "cleanup";
      if (outcome.phase === "done") {
        undoStack.notifyWithUndo({
          kind,
          message: doneToast(mode, outcome.run, preview),
          batchIds: outcome.run.batchIds,
        });
        dispatch({ type: "SETTLE" });
        void invalidateAfterActions(qc);
        return;
      }
      if (outcome.run.executed > 0) {
        undoStack.notifyWithUndo({
          kind,
          message: partialToast(mode, outcome.run),
          batchIds: outcome.run.batchIds,
        });
      }
    });
  }, [announce, qc, sleep, undoStack]);

  const cancel = useCallback(() => dispatch({ type: "CANCEL" }), []);
  const stop = useCallback(() => {
    signal.current.stop = true;
    dispatch({ type: "STOP" });
  }, []);
  const dismiss = useCallback(() => {
    dispatch({ type: "DISMISS" });
    void invalidateAfterActions(qc);
  }, [qc]);
  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.machine.phase !== "partial") return;
    dispatch({ type: "RETRY" });
    stateRef.current = { ...s, machine: { phase: "preparing" } };
    void fetchPreview(s.mode, s.accountId);
  }, [fetchPreview]);

  const value = useMemo<CleanupApi>(() => {
    const m = state.machine;
    const progressLabel = m.phase === "running" ? `${percentOf(m.run)}%` : null;
    const busyPhase =
      m.phase === "preparing"
        ? "preparing"
        : m.phase === "running" || m.phase === "confirming"
          ? "busy"
          : "idle";
    return {
      state,
      start,
      confirm,
      cancel,
      stop,
      retry,
      dismiss,
      barVisible: barVisible(state),
      progressLabel,
      busyPhase,
    };
  }, [state, start, confirm, cancel, stop, retry, dismiss]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCleanup(): CleanupApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCleanup needs CleanupProvider");
  return v;
}
