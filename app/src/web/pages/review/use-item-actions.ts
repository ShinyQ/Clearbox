import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SenderGroup, SuggestionItem } from "../../../shared/api.ts";
import { isApiError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { qk } from "../../api/keys.ts";
import { usePatchSender } from "../../api/mutations.ts";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import { actionErrorMessage, GENERIC_ERROR, perEmailToast } from "../../lib/copy-actions.ts";
import { plural } from "../../lib/format.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { useUndoStack } from "../../state/UndoStackProvider.tsx";
import {
  adjustSummary,
  bumpGroupCount,
  captureItemPositions,
  removeGroupFromCache,
  removeItemFromDetail,
  restoreItem,
} from "./group-cache.ts";
import type { GroupActionCallbacks, GroupActionsApi } from "./use-group-actions.ts";

export function useItemActions(groupActions: GroupActionsApi, cb: GroupActionCallbacks) {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndoStack();
  const patchSender = usePatchSender();
  const [busyItemIds, setBusyItemIds] = useState<ReadonlySet<number>>(new Set());
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  const setBusy = (id: number, on: boolean) =>
    setBusyItemIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const itemAction = useCallback(
    async (group: SenderGroup, item: SuggestionItem, action: ActionKind) => {
      setBusy(item.id, true);
      const last = group.count === 1;
      const positions = captureItemPositions(qc, group.key, item.id);
      removeItemFromDetail(qc, group.key, item.id);
      bumpGroupCount(qc, group.key, -1);
      adjustSummary(qc, group.accountId, group.action, -1, last ? -1 : 0);
      cbRef.current.onDelta(-1, last ? -1 : 0);
      try {
        const res =
          item.action !== "unsure" && item.action === action
            ? await api.approve({ ids: [item.id] })
            : await api.override({ ids: [item.id], action });
        if (res.executed + res.skipped === 0) {
          const codes = Object.fromEntries(res.results.filter((r) => r.error).map((r) => [r.error, 1]));
          throw Object.assign(new Error("no progress"), { codes });
        }
        undo.notifyWithUndo({
          kind: "action",
          message: perEmailToast(action),
          batchIds: res.batchId === null ? [] : [res.batchId],
        });
        if (last) {
          cbRef.current.onRemoved([group.key]);
          removeGroupFromCache(qc, group.key);
          qc.removeQueries({ queryKey: qk.group(group.key) });
        } else {
          void qc.invalidateQueries({ queryKey: qk.group(group.key) });
        }
        void qc.invalidateQueries({ queryKey: ["queue"] });
      } catch (e) {
        restoreItem(qc, positions);
        bumpGroupCount(qc, group.key, 1);
        adjustSummary(qc, group.accountId, group.action, 1, last ? 1 : 0);
        cbRef.current.onDelta(1, last ? 1 : 0);
        const codes = (e as { codes?: Record<string, number> }).codes ?? {};
        groupActions.showError(group, { executed: 0, codes, error: isApiError(e) ? e : null });
      } finally {
        setBusy(item.id, false);
      }
    },
    [groupActions, qc, undo],
  );

  const alwaysKeep = useCallback(
    async (group: SenderGroup, entry: string, asOf: string) => {
      try {
        await patchSender.mutateAsync({ entry, list: "allow" });
      } catch {
        toast.show({ kind: "error", message: GENERIC_ERROR });
        return;
      }
      const label = entry.startsWith("@") ? entry : displayName(group).text;
      await groupActions.act(
        group,
        "keep",
        asOf,
        (n) => `${label} is on your Always keep list. ${plural(n, "email", "emails")} kept.`,
      );
    },
    [groupActions, patchSender, toast],
  );

  const alwaysTrash = useCallback(
    async (group: SenderGroup) => {
      try {
        await patchSender.mutateAsync({ entry: group.sender, list: "deny" });
        toast.show({
          kind: "info",
          message: `${displayName(group).text} is on your Always OK to trash list. Future emails from it skip the confidence check.`,
        });
      } catch (e) {
        toast.show({
          kind: "error",
          message: actionErrorMessage(
            isApiError(e) ? e.code : null,
            cbRef.current.errorContext(group.accountId),
          ),
        });
      }
    },
    [patchSender, toast],
  );

  const copyAddress = useCallback(
    async (group: SenderGroup) => {
      try {
        await navigator.clipboard.writeText(group.sender);
        toast.show({ kind: "info", message: `Copied ${group.sender}.` });
      } catch {
        toast.show({ kind: "error", message: GENERIC_ERROR });
      }
    },
    [toast],
  );

  return useMemo(
    () => ({ itemAction, alwaysKeep, alwaysTrash, copyAddress, busyItemIds }),
    [itemAction, alwaysKeep, alwaysTrash, copyAddress, busyItemIds],
  );
}
