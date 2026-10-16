import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AccountView, SenderGroup } from "../../../shared/api.ts";
import { api } from "../../api/endpoints.ts";
import { actOnGroup, type GroupActionResult } from "../../api/group-actions.ts";
import { qk } from "../../api/keys.ts";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import type { BulkAction } from "../../components/review/SelectionToolbar.tsx";
import {
  actionErrorMessage,
  approveSummaryToast,
  bulkActionToast,
  groupActionToast,
  partialGroupToast,
  type ActionErrorContext,
} from "../../lib/copy-actions.ts";
import { isKeepAction, isKeepOnly } from "../../lib/keep-only.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { useUndoStack } from "../../state/UndoStackProvider.tsx";
import {
  adjustSummary,
  captureGroupPositions,
  patchGroupCount,
  removeGroupFromCache,
  restoreGroup,
  rowExitDelayMs,
} from "./group-cache.ts";

const DEPS = { approve: api.approve, override: api.override, groupDetail: api.groupDetail };

export interface GroupActionCallbacks {
  onRemoved: (keys: string[]) => void;
  onRestored: (key: string) => void;
  onDelta: (dEmails: number, dGroups: number) => void;
  errorContext: (accountId: string) => ActionErrorContext;
  accountFor: (accountId: string) => AccountView | undefined;
}

export interface GroupActionsApi {
  busyKeys: ReadonlySet<string>;
  exitingKeys: ReadonlySet<string>;
  busyAction: { key: string; action: ActionKind } | null;
  bulkProgress: { done: number; total: number } | null;
  act: (
    group: SenderGroup,
    target: ActionKind,
    asOf: string,
    message?: (executed: number) => string,
  ) => Promise<boolean>;
  bulk: (groups: readonly SenderGroup[], action: BulkAction, asOf: string) => Promise<string[]>;
  showError: (group: SenderGroup, result: Pick<GroupActionResult, "codes" | "error" | "executed">) => void;
}

function toggle(set: Dispatch<SetStateAction<ReadonlySet<string>>>, key: string, on: boolean) {
  set((prev) => {
    const next = new Set(prev);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });
}

export function useGroupActions(cb: GroupActionCallbacks): GroupActionsApi {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndoStack();
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [exitingKeys, setExitingKeys] = useState<ReadonlySet<string>>(new Set());
  const [busyAction, setBusyAction] = useState<{ key: string; action: ActionKind } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Set<string>());
  const bulkRunning = useRef(false);

  const exit = useCallback(
    (key: string) => {
      toggle(setExitingKeys, key, true);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          cbRef.current.onRemoved([key]);
          removeGroupFromCache(qc, key);
          toggle(setExitingKeys, key, false);
        }, rowExitDelayMs()),
      );
    },
    [qc],
  );

  const cancelExit = useCallback((key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    toggle(setExitingKeys, key, false);
  }, []);

  const showError = useCallback<GroupActionsApi["showError"]>(
    (group, result) => {
      const account = cbRef.current.accountFor(group.accountId);
      if (result.executed === 0 && (result.codes.account_inactive ?? 0) > 0) {
        toast.show({
          kind: "error",
          message: `Reconnect ${account?.email ?? "this account"} to act on its emails.`,
          action: account
            ? {
                label: "Reconnect",
                onAction: () =>
                  startOAuth(account.provider, { returnTo: "/accounts", loginHint: account.email }),
              }
            : undefined,
        });
        return;
      }
      const code = result.error?.code ?? ((result.codes.rate_limited ?? 0) > 0 ? "rate_limited" : null);
      toast.show({
        kind: "error",
        message: actionErrorMessage(code, cbRef.current.errorContext(group.accountId)),
      });
    },
    [toast],
  );

  const act = useCallback<GroupActionsApi["act"]>(
    async (group, target, asOf, message) => {
      if (inflight.current.has(group.key)) return false;
      inflight.current.add(group.key);
      const positions = captureGroupPositions(qc, group.key);
      setBusyAction({ key: group.key, action: target });
      adjustSummary(qc, group.accountId, group.action, -group.count, -1);
      cbRef.current.onDelta(-group.count, -1);
      exit(group.key);
      const result = await actOnGroup(group, target, asOf, DEPS);
      inflight.current.delete(group.key);
      setBusyAction(null);
      const done = result.executed + result.skipped;
      if (done === 0) {
        cancelExit(group.key);
        restoreGroup(qc, positions);
        adjustSummary(qc, group.accountId, group.action, group.count, 1);
        cbRef.current.onDelta(group.count, 1);
        cbRef.current.onRestored(group.key);
        showError(group, result);
        return false;
      }
      if (done < group.count) {
        cancelExit(group.key);
        restoreGroup(qc, positions);
        patchGroupCount(qc, group.key, group.count - done);
        adjustSummary(qc, group.accountId, group.action, group.count - done, 1);
        cbRef.current.onDelta(group.count - done, 1);
        cbRef.current.onRestored(group.key);
        undo.notifyWithUndo({
          kind: "action",
          message: partialGroupToast(target, result.executed, group.count),
          batchIds: result.batchIds,
          keepOnly: isKeepAction(target),
        });
        void qc.invalidateQueries({ queryKey: qk.group(group.key) });
        return false;
      }
      const name = displayName(group).text;
      undo.notifyWithUndo({
        kind: "action",
        message: message ? message(result.executed) : groupActionToast(target, name, result.executed),
        batchIds: result.batchIds,
        keepOnly: isKeepAction(target),
      });
      qc.removeQueries({ queryKey: qk.group(group.key) });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["cleanup"] });
      return true;
    },
    [cancelExit, exit, qc, showError, undo],
  );

  const bulk = useCallback<GroupActionsApi["bulk"]>(
    async (groups, action, asOf) => {
      // A second bulk (or an empty one) must not touch the running bulk's busy keys or progress.
      if (groups.length === 0 || bulkRunning.current) return [];
      bulkRunning.current = true;
      setBusyKeys(new Set(groups.map((g) => g.key)));
      const doneKeys: string[] = [];
      const batchIds: number[] = [];
      const by: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
      let executed = 0;
      let touched = 0;
      let firstError: { group: SenderGroup; result: GroupActionResult } | null = null;
      for (const [i, g] of groups.entries()) {
        setBulkProgress({ done: i + 1, total: groups.length });
        const target: ActionKind =
          action === "approve" ? (g.action === "unsure" ? "keep" : g.action) : action;
        const r = await actOnGroup(g, target, asOf, DEPS);
        toggle(setBusyKeys, g.key, false);
        executed += r.executed;
        by[target] += r.executed;
        batchIds.push(...r.batchIds);
        const done = r.executed + r.skipped;
        if (done >= g.count) {
          touched += 1;
          doneKeys.push(g.key);
          adjustSummary(qc, g.accountId, g.action, -g.count, -1);
          cbRef.current.onDelta(-g.count, -1);
          exit(g.key);
        } else if (done > 0) {
          touched += 1;
          patchGroupCount(qc, g.key, g.count - done);
          adjustSummary(qc, g.accountId, g.action, -done, 0);
          cbRef.current.onDelta(-done, 0);
        }
        if (done === 0 || r.error) {
          firstError ??= { group: g, result: r };
          if (r.error?.code === "budget_exhausted" || r.error?.code === "network") break;
        }
      }
      bulkRunning.current = false;
      setBusyKeys(new Set());
      setBulkProgress(null);
      if (executed > 0) {
        const target: ActionKind = action === "approve" ? "delete" : action;
        undo.notifyWithUndo({
          kind: "action",
          message:
            action === "approve" ? approveSummaryToast(by) : bulkActionToast(target, executed, touched),
          batchIds,
          keepOnly: isKeepOnly(by),
        });
      }
      if (firstError) showError(firstError.group, firstError.result);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["cleanup"] });
      return doneKeys;
    },
    [exit, qc, showError, undo],
  );

  return useMemo(
    () => ({ busyKeys, exitingKeys, busyAction, bulkProgress, act, bulk, showError }),
    [busyKeys, exitingKeys, busyAction, bulkProgress, act, bulk, showError],
  );
}
