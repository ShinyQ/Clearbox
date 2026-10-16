import { useEffect } from "react";
import { useRouteError } from "react-router";
import type { SessionError } from "../api/client.ts";
import { Brand } from "../components/shell/SidebarNav.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { Icon } from "../components/ui/icons.tsx";
import { browser, SIGN_OUT_URL } from "../lib/links.ts";
import { reportBug } from "../lib/report.ts";

export type FullPageErrorKind = SessionError | "boundary";

interface ErrorCopy {
  title: string;
  body: string;
  action?: { label: string; primary: boolean; run: () => void };
}

const COPY: Record<FullPageErrorKind, ErrorCopy> = {
  unauthenticated: {
    title: "Your session expired",
    body: "Sign in again to keep using Clearbox.",
    action: { label: "Sign in again", primary: true, run: () => browser.reload() },
  },
  forbidden: {
    title: "This Clearbox belongs to someone else",
    body: "Sign in with the owner's email address.",
    action: { label: "Sign out", primary: false, run: () => browser.assign(SIGN_OUT_URL) },
  },
  access_misconfigured: {
    title: "Sign-in protection is not configured",
    body: "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and OWNER_EMAIL as Worker secrets, then redeploy. See docs/setup-cloudflare.md.",
  },
  boundary: {
    title: "Something went wrong on this page",
    body: "Reload to try again. Your data is safe: Clearbox only acts when you confirm.",
    action: { label: "Reload", primary: true, run: () => browser.reload() },
  },
};

/** The router error element renders this outside RootLayout, so it uses no providers or query hooks. */
export function FullPageError({
  kind,
  withBrandLink = false,
}: {
  kind: FullPageErrorKind;
  withBrandLink?: boolean;
}) {
  const c = COPY[kind];
  return (
    <main id="main" className="mx-auto max-w-[560px] px-4 pt-12">
      {withBrandLink ? (
        <Brand />
      ) : (
        <p className="flex items-center gap-[9px] px-2 pb-3.5 text-title-sm font-heading text-ink">
          <span
            aria-hidden="true"
            className="grid size-[22px] place-items-center rounded-md bg-ink text-white"
          >
            <Icon name="review" size={14} strokeWidth={2} />
          </span>
          Clearbox
        </p>
      )}
      <EmptyState
        variant="page"
        title={c.title}
        body={c.body}
        action={
          c.action
            ? {
                label: c.action.label,
                onClick: c.action.run,
                variant: c.action.primary ? "primary" : "secondary",
              }
            : undefined
        }
      />
    </main>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  useEffect(() => reportBug("Uncaught render error", error), [error]);
  return <FullPageError kind="boundary" />;
}
