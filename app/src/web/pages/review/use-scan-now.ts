import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { AccountView } from "../../../shared/api.ts";
import { isApiError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { minutesUntil } from "../../lib/account-status.ts";
import { GENERIC_ERROR } from "../../lib/copy-actions.ts";
import { formatClock, localResetTime, plural } from "../../lib/format.ts";
import { useToast } from "../../state/ToastProvider.tsx";

/** UI spec 5.1 Scan now: the selected account, or every active unpaused account in sequence. */
export function useScanNow(accounts: readonly AccountView[], accountId: string | undefined) {
  const [scanning, setScanning] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const run = useCallback(async () => {
    const single = accountId !== undefined;
    const targets = single
      ? accounts.filter((a) => a.id === accountId)
      : accounts.filter((a) => a.status === "active" && !a.paused);
    setScanning(true);
    let sorted = 0;
    let finished = false;
    for (const a of targets) {
      try {
        const r = await api.scanAccount(a.id);
        sorted += r.decided + r.unsure;
        finished = true;
      } catch (e) {
        const code = isApiError(e) ? e.code : null;
        const retryAt = isApiError(e) ? e.retryAt : undefined;
        if (code === "account_busy") {
          const mins = minutesUntil(retryAt ?? new Date().toISOString(), Date.now());
          toast.show({
            kind: "info",
            message: `A scan is already running for ${a.email}. Try again in ${mins} min.`,
          });
        } else if (code === "account_inactive") {
          // With retryAt the account is backing off after an error; without it the account needs attention.
          if (retryAt)
            toast.show({
              kind: "info",
              message: `${a.email} is retrying after a problem. Next try at ${formatClock(retryAt)}.`,
            });
          else if (single) toast.show({ kind: "info", message: `${a.email} is paused.` });
        } else if (code === "budget_exhausted") {
          toast.show({
            kind: "info",
            message: `Today's free-tier limit is reached. Scanning resumes after ${localResetTime(Date.now())}.`,
          });
          break;
        } else {
          toast.show({ kind: "error", message: GENERIC_ERROR });
        }
      }
    }
    if (finished) {
      toast.show({
        kind: "info",
        message:
          sorted === 0
            ? "Scan finished. No new emails."
            : `Scan finished. ${plural(sorted, "new email", "new emails")} sorted.`,
      });
    }
    setScanning(false);
    await Promise.all(["accounts", "queue", "cleanup"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  }, [accountId, accounts, qc, toast]);
  return { scanning, run };
}
