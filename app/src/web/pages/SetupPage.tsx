import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { AccountView } from "../../shared/api.ts";
import { useAccounts, useMe, useQueueSummary } from "../api/queries.ts";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { Brand } from "../components/shell/SidebarNav.tsx";
import { Button, LinkButton } from "../components/ui/Button.tsx";
import { Icon } from "../components/ui/icons.tsx";
import { ProgressBar } from "../components/ui/ProgressBar.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { VisuallyHidden } from "../components/ui/VisuallyHidden.tsx";
import { MODEL_BODY, type AppBannerSpec } from "../lib/banners.ts";
import { formatCount, plural } from "../lib/format.ts";
import { docsUrl } from "../lib/links.ts";
import { NOT_CONFIGURED, oauthErrorBanner } from "../lib/oauth-errors.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import type { ProviderKind } from "../lib/view-types.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { usePageshowReset } from "../state/use-pageshow-reset.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { firstSortProgress } from "./review/review-state.ts";

export type StepStatus = "done" | "warning" | "error" | "pending";

const STATUS: Record<
  StepStatus,
  { icon: "success" | "warning" | "error" | null; className: string; label: string }
> = {
  done: { icon: "success", className: "text-keep-ink", label: "Done" },
  warning: { icon: "warning", className: "text-check-ink", label: "Needs attention" },
  error: { icon: "error", className: "text-trash-ink", label: "Problem" },
  pending: { icon: null, className: "", label: "Not done yet" },
};

export function SetupStep({
  status,
  title,
  children,
  action,
}: {
  status: StepStatus;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const s = STATUS[status];
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
      <span className="pt-0.5">
        {s.icon ? (
          <Icon name={s.icon} size={16} className={s.className} />
        ) : (
          <span aria-hidden="true" className="block size-4 rounded-full border-[1.5px] border-line-control" />
        )}
        <VisuallyHidden>{s.label}</VisuallyHidden>
      </span>
      <div className="min-w-0">
        <h2 className="font-emphasis text-ink">{title}</h2>
        <div className="text-small text-ink-3">{children}</div>
      </div>
      {action ? <div className="flex flex-col items-end gap-1.5">{action}</div> : null}
    </li>
  );
}

function phaseText(a: AccountView): string {
  if (a.sync.phase === "sent_backfill") return "Learning who you write to (step 1 of 3)";
  if (a.sync.phase === "inbox_backfill") {
    return `Sorting your inbox, newest first (step 2 of 3). ${formatCount(a.sync.messagesIngested)} emails sorted.`;
  }
  return "Caught up (step 3 of 3).";
}

export function SetupPage() {
  useDocumentTitle("Set up Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [oauth] = useState(() => ({
    error: params.get("error"),
    provider: params.get("provider"),
    connected: params.get("connected"),
  }));
  useEffect(() => {
    if (oauth.error || oauth.provider || oauth.connected) setParams({}, { replace: true });
  }, [oauth, setParams]);
  const me = useMe();
  const accounts = useAccounts({ fast: true });
  const summary = useQueueSummary();
  const list = accounts.data?.accounts ?? [];
  const issues = new Set((me.data?.issues ?? []).map((i) => i.code));
  const modelCode = (
    ["decision_not_configured", "decision_auth_failed", "decision_deployment_not_found"] as const
  ).find((c) => issues.has(c));
  const [opening, setOpening] = useState<ProviderKind | null>(null);
  usePageshowReset(() => setOpening(null));
  const connect = (p: ProviderKind) => {
    setOpening(p);
    startOAuth(p, { returnTo: "/setup" });
  };
  const provider: ProviderKind | null =
    oauth.provider === "outlook" ? "outlook" : oauth.provider === "gmail" ? "gmail" : null;
  const banner = oauth.error
    ? oauthErrorBanner(oauth.error, provider, () => connect(provider ?? "gmail"))
    : null;
  const extra: AppBannerSpec[] = banner ? [banner] : [];
  const groups = summary.data?.groups ?? 0;
  const ready = (summary.data?.pending.total ?? 0) > 0;
  const progress = firstSortProgress(list);
  const loading = me.isPending || accounts.isPending;
  const development = me.data?.environment === "development";
  const meFailed = me.isError && !me.data;
  const accountsFailed = accounts.isError && !accounts.data;

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-[560px] px-4 pt-12 pb-8 focus:outline-none">
      <Brand />
      <h1 ref={titleRef} tabIndex={-1} className="text-h1 font-heading text-ink focus:outline-none">
        Set up Clearbox
      </h1>
      <p className="mt-1 mb-4 text-ink-2">
        Three checks, then Clearbox sorts your mailbox in the background.
      </p>
      <AppBanners page="setup" extra={extra} />
      {loading ? (
        <div aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <span className="sr-only">Loading setup checks</span>
          {[0, 1, 2].map((i) => (
            <SkeletonLine key={i} width="70%" />
          ))}
        </div>
      ) : (
        <ol className="rounded-xl border border-line bg-surface">
          <SetupStep
            status={meFailed ? "pending" : development ? "warning" : "done"}
            title="Sign-in protection"
          >
            {meFailed
              ? "Couldn't load your sign-in status."
              : development
                ? "Local development mode. Sign-in is bypassed on localhost only."
                : `Protected by Cloudflare Access. Signed in as ${me.data?.email ?? ""}.`}
          </SetupStep>
          <SetupStep
            status={meFailed ? "pending" : modelCode ? "error" : "done"}
            title="AI model"
            action={
              modelCode ? (
                <LinkButton href={docsUrl("setup-azure.md")} external variant="ghost" size="sm">
                  Open setup guide
                </LinkButton>
              ) : undefined
            }
          >
            {meFailed
              ? "Couldn't check the AI model."
              : modelCode
                ? `${MODEL_BODY[modelCode] ?? ""} New emails will be marked Check until this is fixed.`
                : "Connected to your Decision-1 deployment."}
          </SetupStep>
          <SetupStep
            status={list.length > 0 ? "done" : "pending"}
            title="Connect a mailbox"
            action={
              <>
                {(["gmail", "outlook"] as const).map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    softDisabled={me.data?.providers[p] === false}
                    loading={opening === p}
                    loadingLabel={p === "gmail" ? "Opening Google…" : "Opening Microsoft…"}
                    onClick={() => connect(p)}
                  >
                    {p === "gmail" ? "Connect Gmail" : "Connect Outlook"}
                  </Button>
                ))}
              </>
            }
          >
            {accountsFailed
              ? "Couldn't load your mailboxes."
              : list.length > 0
                ? list.map((a) => <span key={a.id} className="block">{`${a.email} connected.`}</span>)
                : "Connect Gmail or Outlook. You'll sign in on their page."}
            {me.data && !me.data.providers.gmail ? (
              <span className="block">{NOT_CONFIGURED.gmail}</span>
            ) : null}
            {me.data && !me.data.providers.outlook ? (
              <span className="block">{NOT_CONFIGURED.outlook}</span>
            ) : null}
          </SetupStep>
        </ol>
      )}
      {meFailed || accountsFailed ? (
        <div className="mt-3">
          <Button
            size="sm"
            onClick={() => {
              if (meFailed) void me.refetch();
              if (accountsFailed) void accounts.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <p className="mt-2.5 text-small text-ink-3">
        Clearbox can only move mail to Trash or Archive. It never permanently deletes or sends email. It
        stores sender, subject, date and a short preview, never full email bodies.
      </p>
      {list.length > 0 ? (
        <section aria-labelledby="first-sort" className="mt-6 flex flex-col gap-2">
          <h2 id="first-sort" className="text-title font-semibold text-ink">
            Sorting your first emails
          </h2>
          {list.map((a) => (
            <p key={a.id} className="text-small text-ink-2">
              {phaseText(a)}
            </p>
          ))}
          <ProgressBar value={progress.value} tone="archive" height={6} label="Sorting progress" />
          <div className="mt-2 flex flex-col items-start gap-1">
            <Button variant="primary" softDisabled={!ready} onClick={() => void navigate("/review")}>
              Go to Review
            </Button>
            <p className="text-small text-ink-3">
              {ready
                ? `${plural(groups, "sender group", "sender groups")} ${groups === 1 ? "is" : "are"} ready.`
                : "Your first suggestions appear within a few minutes."}
            </p>
          </div>
        </section>
      ) : null}
    </main>
  );
}
