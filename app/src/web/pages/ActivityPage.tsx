import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { ActivityEntry, UndoResponse } from "../../shared/api.ts";
import { isApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { useAccounts, useActivity, useBatches } from "../api/queries.ts";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button, LinkButton } from "../components/ui/Button.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Table } from "../components/ui/Table.tsx";
import { describeActivity, type ActivityRow } from "../lib/activity.ts";
import { GENERIC_ERROR, NETWORK_ERROR, undoExpiredMessage, undoResultToast } from "../lib/copy-actions.ts";
import { activityWhen } from "../lib/format.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import { reportBug } from "../lib/report.ts";
import { useToast, type ToastApi } from "../state/ToastProvider.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";

type Row = ActivityEntry & { view: ActivityRow };
type ToastInput = Parameters<ToastApi["show"]>[0];

/**
 * The server resets its claim only when nothing was restored and something failed, so only that
 * case can be retried. A partly restored undo stays undone and the row shows "Undone".
 */
function undoToast(res: UndoResponse): ToastInput {
  if (res.restored === 0 && res.failed > 0) {
    return {
      kind: "error",
      message: "Nothing could be restored and nothing was changed. You can try Undo again.",
    };
  }
  return undoResultToast("action", res.restored, res.failed);
}

function undoFailure(e: unknown): string {
  if (isApiError(e) && e.code === "undo_expired") return undoExpiredMessage("action");
  if (isApiError(e) && e.code === "network") return NETWORK_ERROR;
  return GENERIC_ERROR;
}

export function ActivityPage() {
  useDocumentTitle("Activity · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const [params, setParams] = useSearchParams();
  const accountId = params.get("account") ?? undefined;
  const activity = useActivity(accountId);
  const batches = useBatches(true);
  const accounts = useAccounts();
  const now = useNow();
  const toast = useToast();
  const qc = useQueryClient();
  const [undoing, setUndoing] = useState<number | null>(null);
  const focusAfterUndo = useRef<number | null>(null);
  const [expired, setExpired] = useState<ReadonlySet<number>>(new Set());

  const accountList = accounts.data?.accounts;
  const rows: Row[] = useMemo(() => {
    const ctx = {
      accountsById: Object.fromEntries((accountList ?? []).map((a) => [a.id, a])),
      batchesById: Object.fromEntries((batches.data ?? []).map((b) => [b.id, b])),
    };
    const entries = activity.data?.pages.flatMap((p) => p.items) ?? [];
    return entries.map((e) => ({ ...e, view: describeActivity(e, ctx) }));
  }, [activity.data, batches.data, accountList]);

  const undo = async (batchId: number) => {
    setUndoing(batchId);
    focusAfterUndo.current = batchId;
    try {
      toast.show(undoToast(await api.undoBatch(batchId)));
    } catch (e) {
      if (isApiError(e) && e.code === "undo_expired") setExpired((s) => new Set([...s, batchId]));
      else if (!isApiError(e)) reportBug("Undo from Activity failed", e);
      toast.show({ kind: "error", message: undoFailure(e) });
    } finally {
      try {
        await invalidateAfterActions(qc);
      } catch (e) {
        reportBug("Refreshing after undo failed", e);
      } finally {
        setUndoing(null);
      }
    }
  };

  // The pressed Undo button is replaced by terminal text; move focus there so it doesn't fall to the body.
  // The marker is consumed when the text mounts, which can happen after the undo handler has finished.
  const terminalText = (batchId: number | null, text: string) => (
    <span
      tabIndex={-1}
      className="text-small text-ink-3 outline-none"
      ref={(el) => {
        if (el && batchId !== null && focusAfterUndo.current === batchId) {
          focusAfterUndo.current = null;
          el.focus();
        }
      }}
    >
      {text}
    </span>
  );

  const loadMore = async () => {
    const res = await activity.fetchNextPage();
    if (res.isError) toast.show({ kind: "error", message: "Couldn't load more. Try again." });
  };

  const lastCell = (row: Row) => {
    const last = row.view.last;
    if (!last) return null;
    switch (last.kind) {
      case "undo":
        if (expired.has(last.batchId)) return terminalText(last.batchId, "Undo expired");
        return (
          <Button
            size="sm"
            loading={undoing === last.batchId}
            loadingLabel="Undoing…"
            softDisabled={undoing !== null && undoing !== last.batchId}
            onClick={() => void undo(last.batchId)}
          >
            Undo
          </Button>
        );
      case "undone":
        return terminalText(row.batchId, "Undone");
      case "expired":
        return terminalText(row.batchId, "Undo expired");
      case "reconnect":
        return (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              startOAuth(last.account.provider, { returnTo: "/accounts", loginHint: last.account.email })
            }
          >
            Reconnect
          </Button>
        );
      case "route":
        return (
          <LinkButton size="sm" variant="ghost" to={last.to}>
            {last.label}
          </LinkButton>
        );
    }
  };

  const options = [
    { value: "all", label: "All accounts" },
    ...(accountList ?? []).map((a) => ({ value: a.id, label: a.email })),
  ];
  if (accountId !== undefined && !options.some((o) => o.value === accountId)) {
    options.push({ value: accountId, label: "A removed account" });
  }

  const queries = [activity, accounts, batches];
  const failed = queries.some((q) => q.isError && q.data === undefined);
  const pending = queries.some((q) => q.isPending);
  const state = failed ? "error" : pending ? "loading" : rows.length === 0 ? "empty" : "ready";

  return (
    <div className="max-w-[1040px]">
      <PageHeader
        title="Activity"
        titleRef={titleRef}
        meta="Undo is available for 24 hours"
        actions={
          <Select
            label="Account"
            value={accountId ?? "all"}
            options={options}
            className="w-[160px]"
            onChange={(v) => setParams(v === "all" ? {} : { account: v })}
          />
        }
      />
      <AppBanners page="activity" />
      <div className="rounded-xl border border-line bg-surface">
        <Table<Row>
          caption="Activity"
          state={state}
          emptyText="Nothing yet. Actions you take and nightly maintenance appear here."
          onRetry={() => {
            for (const q of queries) if (q.isError) void q.refetch();
          }}
          rows={rows}
          rowKey={(r) => r.id}
          rowHover={(r) =>
            r.view.last !== null && r.view.last.kind !== "undone" && r.view.last.kind !== "expired"
          }
          columns={[
            { key: "when", header: "When", className: "w-[170px]", render: (r) => activityWhen(r.ts, now) },
            {
              key: "what",
              header: "What",
              render: (r) => (
                <span>
                  <b className="font-emphasis text-ink">{r.view.verb}</b>
                  {r.view.detail ? ` · ${r.view.detail}` : ""}
                </span>
              ),
            },
            { key: "account", header: "Accounts", render: (r) => r.view.account },
            { key: "result", header: "Result", render: (r) => r.view.result },
            { key: "action", header: "Actions", srOnlyHeader: true, align: "right", render: lastCell },
          ]}
        />
      </div>
      {state === "ready" && activity.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="ghost"
            loading={activity.isFetchingNextPage}
            loadingLabel="Loading…"
            onClick={() => void loadMore()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
