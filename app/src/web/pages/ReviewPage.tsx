import { useNavigate } from "react-router";
import { ActionTabs } from "../components/review/ActionTabs.tsx";
import { CleanupBar } from "../components/review/CleanupBar.tsx";
import { SummaryCard } from "../components/review/SummaryCard.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { ProgressBar } from "../components/ui/ProgressBar.tsx";
import { Select } from "../components/ui/Select.tsx";
import { formatCount, plural } from "../lib/format.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import { firstSortMeta, firstSortProgress, isCatchingUp } from "./review/review-state.ts";
import { ReviewWorkArea } from "./review/ReviewWorkArea.tsx";
import { useReviewController, type ReviewController } from "./review/use-review-controller.ts";

function Header({ c }: { c: ReviewController }) {
  const options = [
    { value: "all", label: "All accounts" },
    ...c.accounts.map((a) => ({ value: a.id, label: a.email })),
  ];
  return (
    <PageHeader
      title="Review"
      titleRef={c.titleRef}
      meta={c.accounts.length > 0 ? c.meta : undefined}
      actions={
        <>
          <Select
            label="Account"
            value={c.accountId ?? "all"}
            options={options}
            onChange={c.changeAccount}
            className="w-[160px]"
          />
          <Button
            variant="ghost"
            icon="refresh"
            loading={c.scan.scanning}
            loadingLabel="Scanning…"
            softDisabled={c.offline}
            onClick={() => void c.scan.run()}
          >
            Scan now
          </Button>
        </>
      }
    />
  );
}

function PageStates({ c }: { c: ReviewController }) {
  const navigate = useNavigate();
  if (c.pageState === "no_accounts") {
    return (
      <EmptyState
        variant="page"
        title="Connect a mailbox to start"
        body="Clearbox sorts Gmail and Outlook. Setup takes about a minute."
        action={{
          label: "Set up Clearbox",
          variant: "primary",
          onClick: () => void navigate("/setup"),
        }}
      />
    );
  }
  if (c.pageState === "error") {
    return (
      <EmptyState
        variant="page"
        title="Couldn't load Review"
        body="Check your connection, then try again."
        action={{
          label: "Try again",
          onClick: () => void Promise.all([c.summaryQ.refetch(), c.previewQ.refetch(), c.groupsQ.refetch()]),
        }}
      />
    );
  }
  if (c.pageState === "all_caught_up") {
    return (
      <EmptyState
        variant="page"
        title="All caught up"
        body="Nothing needs your attention. New mail gets sorted every 30 minutes."
        action={{ label: "Scan now", onClick: () => void c.scan.run() }}
        actionRef={c.emptyActionRef}
      />
    );
  }
  const progress = firstSortProgress(c.scope);
  return (
    <EmptyState
      variant="page"
      title="Sorting your mailbox"
      body="Clearbox reads your newest emails first. Your first suggestions appear within a few minutes."
    >
      <div className="mx-auto mb-2 max-w-[340px]">
        <ProgressBar value={progress.value} tone="archive" height={6} label="Sorting progress" />
      </div>
      <p className="text-small text-ink-3">
        {firstSortMeta({ sorted: formatCount(progress.sorted), scope: progress.scope })}
      </p>
    </EmptyState>
  );
}

export function ReviewPage() {
  const c = useReviewController();
  const preview = c.previewQ.data ?? null;
  const summary = c.summaryQ.data;
  const ready = c.pageState === "ready" || c.pageState === "loading";
  const confirmKeeps =
    c.tab === "keep" && c.groups.length > 0
      ? {
          onClick: () => c.cleanup.start("confirm_keeps", c.accountId),
          busy: c.cleanup.busyPhase === "preparing" && c.cleanup.state.mode === "confirm_keeps",
        }
      : null;
  return (
    <>
      <Header c={c} />
      <AppBanners
        page="review"
        awaitingModel={summary?.awaitingModel ?? 0}
        modelUnavailableShare={c.modelShare}
      />
      {!ready ? (
        <PageStates c={c} />
      ) : (
        <>
          {c.justCleaned && preview?.count === 0 && (summary?.groups ?? 0) > 0 ? (
            <div className="mb-4">
              <EmptyState
                variant="panel"
                title="Inbox cleared"
                body={`${formatCount(summary?.groups ?? 0)} ${summary?.groups === 1 ? "group is" : "groups are"} waiting for your call. New mail gets sorted every 30 minutes.`}
                action={{
                  label: `Review the ${plural(summary?.groups ?? 0, "group", "groups")}`,
                  onClick: () => c.changeTab("all"),
                }}
                actionRef={c.emptyActionRef}
              />
            </div>
          ) : (
            <SummaryCard
              state={c.summaryState}
              preview={preview}
              pendingTotal={summary?.pending.total ?? 0}
              awaitingModel={summary?.awaitingModel ?? 0}
              groupsLeft={preview && typeof preview.groupsLeft === "number" ? preview.groupsLeft : null}
              tau={c.tau}
              catchingUp={isCatchingUp(c.scope)}
              cleanupPhase={c.cleanup.busyPhase}
              offline={c.offline}
              platform={c.platform}
              onCleanUp={c.startCleanup}
              onRetry={() => void c.previewQ.refetch()}
              buttonRef={c.summaryButtonRef}
            />
          )}
          <ActionTabs
            value={c.tab}
            counts={c.counts}
            onChange={c.changeTab}
            sort={c.sort}
            onSortChange={c.changeSort}
            newSuggestions={c.pill.show}
            onRefresh={() => void c.groupsQ.refetch()}
            confirmKeeps={confirmKeeps}
          />
          <ReviewWorkArea c={c} />
          <CleanupBar
            context={c.copyContext}
            platform={c.platform}
            onReconnect={() => {
              const a = c.scope.find((x) => x.status === "needs_reauth");
              if (a) startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email });
            }}
          />
        </>
      )}
    </>
  );
}
