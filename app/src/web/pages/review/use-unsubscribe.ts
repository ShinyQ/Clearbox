import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { SenderGroup, UnsubscribeResponse } from "../../../shared/api.ts";
import { isApiError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { qk } from "../../api/keys.ts";
import type { UnsubscribeChoice, UnsubscribePhase } from "../../components/review/UnsubscribeSection.tsx";
import { actionErrorMessage, type ActionErrorContext } from "../../lib/copy-actions.ts";
import {
  trashAndUnsubscribeToast,
  unsubscribeDoneToast,
  unsubscribeErrorMessage,
} from "../../lib/copy-unsubscribe.ts";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { useToast } from "../../state/ToastProvider.tsx";
import type { GroupActionsApi } from "./use-group-actions.ts";

export interface UnsubscribeApi {
  /** True while any unsubscribe request is in flight (one at a time). */
  busy: boolean;
  phaseFor: (key: string) => UnsubscribePhase;
  runningFor: (key: string) => UnsubscribeChoice | null;
  start: (key: string) => void;
  cancel: () => void;
  confirm: (group: SenderGroup, name: string, choice: UnsubscribeChoice, asOf: string) => Promise<void>;
}

/**
 * Contracts 12.9, UI spec 4.14a. Unsubscribe first (it needs the group's newest pending email), then, for
 * "Trash and unsubscribe", trash the group through the normal group action so it keeps its Undo toast. A failed
 * unsubscribe still trashes: the owner asked for both, and only the trash part can be undone.
 */
export function useUnsubscribe(
  groupActions: Pick<GroupActionsApi, "act">,
  errorContext: (accountId: string) => ActionErrorContext,
  activeKey: string | null,
): UnsubscribeApi {
  const qc = useQueryClient();
  const toast = useToast();
  const announce = useAnnounce();
  const [state, setState] = useState<{ key: string; running: UnsubscribeChoice | null } | null>(null);
  // An open (not running) confirmation belongs to the group it was opened on: moving to another group closes
  // it, so coming back never reopens it with focus on the danger button.
  const inflight = useRef(false);
  const [seenKey, setSeenKey] = useState(activeKey);
  if (seenKey !== activeKey) {
    setSeenKey(activeKey);
    if (state !== null && state.running === null) setState(null);
  }

  const confirm = useCallback<UnsubscribeApi["confirm"]>(
    async (group, name, choice, asOf) => {
      if (inflight.current) return;
      inflight.current = true;
      setState({ key: group.key, running: choice });
      let failure: string | null = null;
      try {
        const res: UnsubscribeResponse = await api.unsubscribe({ groupKey: group.key });
        if (res.outcome !== "unsubscribed") failure = unsubscribeErrorMessage(res.error, name);
      } catch (e) {
        failure = isApiError(e)
          ? actionErrorMessage(e.code, errorContext(group.accountId))
          : unsubscribeErrorMessage(null, name);
      }
      const ok = failure === null;
      void qc.invalidateQueries({ queryKey: ["activity"] });
      if (choice === "trash") {
        await groupActions.act(
          group,
          "delete",
          asOf,
          ok ? (n) => trashAndUnsubscribeToast(name, n) : undefined,
        );
      } else {
        void qc.invalidateQueries({ queryKey: qk.group(group.key) });
      }
      if (ok) {
        if (choice === "only") toast.show({ kind: "success", message: unsubscribeDoneToast(name) });
        else announce(`Unsubscribed from ${name}.`);
      } else {
        toast.show({ kind: "error", message: failure ?? unsubscribeErrorMessage(null, name) });
      }
      inflight.current = false;
      setState((cur) => (cur?.key === group.key ? null : cur));
    },
    [announce, errorContext, groupActions, qc, toast],
  );

  return useMemo(
    () => ({
      busy: state?.running != null,
      phaseFor: (key) => (state?.key !== key ? "idle" : state.running ? "running" : "confirming"),
      runningFor: (key) => (state?.key === key ? state.running : null),
      start: (key) => setState((cur) => (cur?.running ? cur : { key, running: null })),
      cancel: () => setState((s) => (s?.running ? s : null)),
      confirm,
    }),
    [confirm, state],
  );
}
