import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AccountsResponse, PolicyResponse } from "../../shared/api.ts";
import {
  api,
  type DismissRuleSuggestionBody,
  type PatchSenderBody,
  type PutPolicyBody,
} from "./endpoints.ts";
import { qk } from "./keys.ts";

/** Caches touched by any mailbox action, Clean up or undo (UI spec 5.2.2). */
export const ACTION_CACHE_PREFIXES = [
  "queue",
  "cleanup",
  "groups",
  "group",
  "accounts",
  "batches",
  "activity",
  "insights",
] as const;

export async function invalidateAfterActions(qc: QueryClient): Promise<void> {
  await Promise.all(ACTION_CACHE_PREFIXES.map((p) => qc.invalidateQueries({ queryKey: [p] })));
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; paused: boolean }) => api.patchAccount(v.id, { paused: v.paused }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.accounts });
      const prev = qc.getQueryData<AccountsResponse>(qk.accounts);
      if (prev) {
        qc.setQueryData<AccountsResponse>(qk.accounts, {
          accounts: prev.accounts.map((a) => (a.id === v.id ? { ...a, paused: v.paused } : a)),
        });
      }
      return { prev };
    },
    onError: (_error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.accounts, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.accounts }),
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnectAccount(id),
    onSuccess: () => invalidateAfterActions(qc),
  });
}

export function usePatchSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchSenderBody) => api.patchSender(body),
    onSuccess: async (res: PolicyResponse) => {
      qc.setQueryData(qk.policy, res);
      // Contracts 12.10: the server re-fuses pending suggestions of that sender, so Review and the offers change.
      await Promise.all(
        ["queue", "cleanup", "groups", "group", "rules"].map((p) => qc.invalidateQueries({ queryKey: [p] })),
      );
    },
  });
}

export function useDismissRuleSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DismissRuleSuggestionBody) => api.dismissRuleSuggestion(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.ruleSuggestions }),
  });
}

export function usePutPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutPolicyBody) => api.putPolicy(body),
    onSuccess: async (res: PolicyResponse) => {
      qc.setQueryData(qk.policy, res);
      await Promise.all(
        ["queue", "cleanup", "groups", "group", "rules"].map((p) => qc.invalidateQueries({ queryKey: [p] })),
      );
    },
  });
}
