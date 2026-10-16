import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { formatCount, plural } from "../lib/format.ts";
import { reportBug } from "../lib/report.ts";
import { useToast } from "./ToastProvider.tsx";

export type UndoKind = "cleanup" | "action";

interface UndoEntry {
  id: string;
  kind: UndoKind;
  batchIds: number[];
  expiresAt: number;
  toastId?: string;
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

/** `failed` is null when a whole batch call threw, so the number of unrestored emails is unknown. */
export function undoResultMessage(kind: UndoKind, restored: number, failed: number | null): string {
  if (failed === 0) return `Restored ${plural(restored, "email", "emails")} to your inbox.`;
  const rest = kind === "cleanup" ? " and are still in Trash or Archive." : ".";
  const who = failed === null ? "Some" : formatCount(failed);
  return `Restored ${plural(restored, "email", "emails")}. ${who} could not be restored${rest}`;
}

const NETWORK_MESSAGE = "Couldn't reach Clearbox. Check your connection and try again.";

function failureMessage(kind: UndoKind, e: unknown): string {
  if (isApiError(e) && e.code === "undo_expired") return expiredMessage(kind);
  if (isApiError(e) && e.code === "network") return NETWORK_MESSAGE;
  return "Something went wrong. Nothing was changed.";
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
      const id = toastId ?? entry.toastId;
      const target = id ?? toast.show(busy);
      if (id) toast.update(id, busy);
      let restored = 0;
      let failed = 0;
      let firstError: unknown;
      let threw = false;
      for (const batchId of [...entry.batchIds].reverse()) {
        try {
          const res = await api.undoBatch(batchId);
          restored += res.restored;
          failed += res.failed;
        } catch (e) {
          if (!threw) firstError = e;
          threw = true;
        }
      }
      if (restored > 0 || !threw) {
        toast.update(target, {
          kind: threw ? "error" : "success",
          busy: false,
          message: undoResultMessage(entry.kind, restored, threw ? null : failed),
        });
      } else {
        toast.update(target, { kind: "error", busy: false, message: failureMessage(entry.kind, firstError) });
      }
      try {
        await invalidateAfterActions(qc);
      } catch (e) {
        reportBug("Refreshing after undo failed", e);
      }
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
      entry.toastId = toast.show({
        kind: "success",
        message: n.message,
        dedupeKey: n.dedupeKey,
        action: { label: "Undo", shortcut: "mod+z", onAction: () => void undo(entry.id) },
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
