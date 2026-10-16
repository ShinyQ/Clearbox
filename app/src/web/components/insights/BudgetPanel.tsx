import type { Insights } from "../../../shared/api.ts";
import {
  backlogRemaining,
  dailyRateFrom,
  deriveAccountUiStatus,
  etaText,
  minutesUntil,
} from "../../lib/account-status.ts";
import { formatCount, formatMb, formatUsd, localResetTime, relativeAgo } from "../../lib/format.ts";
import { AccountStatusItem } from "../shell/AccountStatusItem.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { Table } from "../ui/Table.tsx";

type Row = Insights["accounts"][number];

function toAccountView(a: Row) {
  return { ...a, statusReason: null, archiveSupported: true, createdAt: "" };
}

export function backlogText(a: Row, rate: number, now: number): string {
  const status = deriveAccountUiStatus(toAccountView(a), now);
  if (status === "up_to_date") return "0";
  if (status === "waiting")
    return `Retrying in ${a.sync.backoffUntil ? minutesUntil(a.sync.backoffUntil, now) : 1} min`;
  if (status !== "catching_up") return "Paused";
  const remaining = backlogRemaining(a);
  return remaining === null
    ? `Sorting, ${formatCount(a.sync.messagesIngested)} so far`
    : `${formatCount(remaining)} emails · ${etaText(remaining, rate)}`;
}

export interface BudgetPanelProps {
  insights: Insights;
  freeTier: boolean;
  now: number;
  budgetExhausted: boolean;
}

export function BudgetPanel({ insights, freeTier, now, budgetExhausted }: BudgetPanelProps) {
  const b = insights.budget;
  const rate = dailyRateFrom(insights.history);
  const pct = Math.min(100, Math.round((b.rowsWritten / b.rowsCap) * 100));
  const reset = localResetTime(now);
  const full = budgetExhausted || b.rowsWritten >= b.rowsCap;
  const writes = `${formatCount(b.rowsWritten)} of ${formatCount(b.rowsCap)} daily writes used (${pct}%)`;
  return (
    <>
      <Table<Row>
        caption="Accounts and daily budget"
        state={insights.accounts.length === 0 ? "empty" : "ready"}
        emptyText="No accounts connected. Connect one in Accounts."
        rows={insights.accounts}
        rowKey={(a) => a.id}
        columns={[
          {
            key: "account",
            header: "Account",
            render: (a) => <b className="font-emphasis text-ink">{a.email}</b>,
          },
          {
            key: "status",
            header: "Status",
            render: (a) => {
              const view = toAccountView(a);
              return (
                <AccountStatusItem
                  account={view}
                  status={deriveAccountUiStatus(view, now)}
                  catchUpPercent={null}
                  variant="inline"
                  now={now}
                  onReconnect={() => undefined}
                />
              );
            },
          },
          { key: "backlog", header: "Backlog", render: (a) => backlogText(a, rate, now) },
          {
            key: "last",
            header: "Last sorted",
            render: (a) => (a.sync.lastTickAt ? relativeAgo(a.sync.lastTickAt, now) : "Not yet"),
          },
          {
            key: "pending",
            header: "Pending",
            align: "right",
            render: (a) => formatCount(a.sync.pendingCount),
          },
        ]}
      />
      <div className="flex flex-col gap-1.5 border-t border-line-subtle px-4 py-3">
        {freeTier ? (
          <>
            <ProgressBar
              value={b.rowsWritten / b.rowsCap}
              tone="accent"
              height={6}
              label="Daily writes used"
              valueText={writes}
            />
            <p className="text-small text-ink-3">
              {full ? `${writes}. Sorting resumes after ${reset}.` : writes}
            </p>
          </>
        ) : null}
        <p className="text-small text-ink-3">
          {`AI model today: ${formatCount(b.decisionCalls)} calls, ${formatCount(b.decisionFailures)} failed, ${formatUsd(b.estimatedDecisionCostUsd)}`}
        </p>
        <p className="text-small text-ink-3">{`Storage: ${formatMb(b.dbSizeBytes)} of ${formatMb(b.dbSizeLimitBytes)}`}</p>
      </div>
    </>
  );
}
