import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { formatCount, plural } from "../lib/format.ts";
import { useToast } from "./ToastProvider.tsx";

export type UndoKind = "cleanup" | "action";

interface UndoEntry {
  id: string;
  kind: UndoKind;
  batchIds: number[];
  expiresAt: number;
}

export interface UndoNotice {
  kind: UndoKind;
  message: string;
  batchIds: number[];
  dedupeKey?: string | undefined;
  expiresAt?: number | undefined;
}

export interface UndoStackApi {
  notifyWithUndo(n: UndoNotice): void;
  undo(entryId: string, toastId?: string): Promise<void>;
  undoLatest(): Promise<void>;
  size: number;
}

const MAX_ENTRIES = 20;
const DAY = 86_400_000;
const Ctx = createContext<UndoStackApi | null>(null);

export function undoResultMessage(kind: UndoKind, restored: number, failed: number): string {
  if (failed === 0) return `Restored ${plural(restored, "email", "emails")} to your inbox.`;
  const rest = kind === "cleanup" ? " and are still in Trash or Archive." : ".";
  return `Restored ${plural(restored, "email", "emails")}. ${formatCount(failed)} could not be restored${rest}`;
}

const expiredMessage = (kind: UndoKind) =>
  `Undo is no longer available for this ${kind === "cleanup" ? "Clean up" : "action"} (24 hours passed).`;

export function UndoStackProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const entries = useRef<UndoEntry[]>([]);
  const counter = useRef(0);
  const [size, setSize] = useState(0);

  // The entry is consumed up front and never re-queued: the server keeps its claim on a
  // partly restored undo (undoable:false), so a retry could not be honored.
  const undo = useCallback(
    async (entryId: string, toastId?: string) => {
      const entry = entries.current.find((e) => e.id === entryId);
      if (!entry) return;
      entries.current = entries.current.filter((e) => e.id !== entryId);
      setSize(entries.current.length);
      const busy = { kind: "info" as const, message: "Undoing…", busy: true, action: undefined };
      const id = toastId ?? toast.show(busy);
      if (toastId) toast.update(toastId, busy);
      let restored = 0;
      let failed = 0;
      try {
        for (const batchId of [...entry.batchIds].reverse()) {
          const res = await api.undoBatch(batchId);
          restored += res.restored;
          failed += res.failed;
        }
        toast.update(id, {
          kind: "success",
          busy: false,
          message: undoResultMessage(entry.kind, restored, failed),
        });
      } catch (e) {
        const message =
          isApiError(e) && e.code === "undo_expired"
            ? expiredMessage(entry.kind)
            : "Something went wrong. Nothing was changed.";
        toast.update(id, { kind: "error", busy: false, message });
      }
      await invalidateAfterActions(qc);
    },
    [qc, toast],
  );

  const notifyWithUndo = useCallback(
    (n: UndoNotice) => {
      if (n.batchIds.length === 0) {
        toast.show({ kind: "success", message: n.message, dedupeKey: n.dedupeKey });
        return;
      }
      const entry: UndoEntry = {
        id: `u${++counter.current}`,
        kind: n.kind,
        batchIds: n.batchIds,
        expiresAt: n.expiresAt ?? Date.now() + DAY,
      };
      entries.current = [...entries.current, entry].slice(-MAX_ENTRIES);
      setSize(entries.current.length);
      let toastId = "";
      toastId = toast.show({
        kind: "success",
        message: n.message,
        dedupeKey: n.dedupeKey,
        action: { label: "Undo", shortcut: "mod+z", onAction: () => void undo(entry.id, toastId) },
      });
    },
    [toast, undo],
  );

  const undoLatest = useCallback(async () => {
    const now = Date.now();
    const latest = [...entries.current].reverse().find((e) => e.expiresAt > now);
    if (!latest) {
      toast.show({
        kind: "info",
        message:
          "Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours.",
        action: { label: "View", onAction: () => void navigate("/activity") },
      });
      return;
    }
    await undo(latest.id);
  }, [navigate, toast, undo]);

  const value = useMemo(
    () => ({ notifyWithUndo, undo, undoLatest, size }),
    [notifyWithUndo, undo, undoLatest, size],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUndoStack(): UndoStackApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUndoStack needs UndoStackProvider");
  return v;
}
