import { useRef } from "react";
import { useAccounts, useInsights, useMe } from "../api/queries.ts";
import { BudgetPanel } from "../components/insights/BudgetPanel.tsx";
import { StatLine } from "../components/insights/StatLine.tsx";
import { ThresholdTable } from "../components/insights/ThresholdTable.tsx";
import { WeeklyChart } from "../components/insights/WeeklyChart.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { Panel } from "../components/ui/Panel.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { toPercent } from "../lib/confidence.ts";
import { formatCount, formatPercent, localResetTime, relativeAgo } from "../lib/format.ts";
import type { Insights } from "../../shared/api.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";

function thresholdText(outcome: Insights["calibration"]["outcome"]): string {
  if (outcome === "calibrated") return "current Clean up threshold, tuned nightly from your choices";
  if (outcome === "no_tau_meets_target") {
    return "highest Clean up threshold. Your recent choices often disagreed with trash suggestions, so Clearbox is being extra careful.";
  }
  return "starting Clean up threshold. Clearbox tunes it after 50 trash decisions.";
}

function MatchPanel({ data, now }: { data: Insights; now: number }) {
  const p = data.precision.deletePrecision;
  return (
    <Panel title="How well Clearbox matches you">
      <StatLine
        value={p === null ? "n/a" : formatPercent(p, 1)}
        text={
          p === null
            ? "Not enough trash decisions yet. Clearbox measures this after 50."
            : "of trash suggestions you agreed with (target 98%)"
        }
      />
      <StatLine
        value={`${toPercent(data.calibration.tauDelete)}%`}
        text={thresholdText(data.calibration.outcome)}
        sub={data.calibration.ranAt ? `Last tuned ${relativeAgo(data.calibration.ranAt, now)}` : undefined}
      />
      <StatLine
        value={formatCount(data.labels.total)}
        text={
          data.labels.total === 0
            ? "No decisions yet. Every Clean up and choice teaches Clearbox."
            : `decisions learned from you (${formatCount(data.labels.last7Days)} this week)`
        }
      />
    </Panel>
  );
}

function LoadingLines() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 p-4">
      <SkeletonLine width={200} height={14} />
      <SkeletonLine width="80%" />
      <SkeletonLine width="60%" />
    </div>
  );
}

export function InsightsPage() {
  useDocumentTitle("Insights · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const insights = useInsights();
  const me = useMe();
  const accounts = useAccounts();
  const now = useNow();
  const awaiting = (accounts.data?.accounts ?? []).reduce((sum, a) => sum + a.sync.awaitingModelCount, 0);
  const data = insights.data;
  const freeTier = me.data?.freeTier ?? true;
  return (
    <div className="max-w-[1040px]">
      <PageHeader title="Insights" titleRef={titleRef} />
      <AppBanners page="insights" awaitingModel={awaiting} />
      {!data && insights.isError ? (
        <EmptyState
          variant="panel"
          title="Couldn't load insights."
          body="Check your connection, then try again."
          action={{ label: "Try again", onClick: () => void insights.refetch() }}
        />
      ) : !data ? (
        <div aria-busy="true">
          <span className="sr-only">Loading insights</span>
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.4fr_1fr]">
            <Panel title="How well Clearbox matches you">
              <LoadingLines />
            </Panel>
            <Panel title="Emails cleaned per week">
              <WeeklyChart weeks={[]} state="loading" />
            </Panel>
          </div>
          <Panel className="mt-3.5" title="Accounts and daily budget">
            <LoadingLines />
          </Panel>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.4fr_1fr]">
            <MatchPanel data={data} now={now} />
            <Panel title="Emails cleaned per week">
              <WeeklyChart
                weeks={data.weekly}
                state={data.weekly.every((w) => w.cleaned === 0) ? "empty" : "ready"}
              />
            </Panel>
          </div>
          <Panel
            className="mt-3.5"
            title="Accounts and daily budget"
            meta={
              freeTier
                ? `Cloudflare free tier · resets ${localResetTime(now)}`
                : "Workers Paid · no daily write cap"
            }
          >
            <BudgetPanel
              insights={data}
              freeTier={freeTier}
              now={now}
              budgetExhausted={(me.data?.issues ?? []).some((i) => i.code === "budget_exhausted_today")}
            />
          </Panel>
          <ThresholdTable calibration={data.calibration} />
        </>
      )}
    </div>
  );
}
