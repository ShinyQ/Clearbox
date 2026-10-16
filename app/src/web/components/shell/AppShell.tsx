import type { ReactNode } from "react";
import { useAccounts, useMe, useQueueSummary } from "../../api/queries.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { useNow } from "../../state/use-now.ts";
import { buttonClass } from "../ui/Button.tsx";
import { SidebarNav, type NavItem } from "./SidebarNav.tsx";
import { TopBar } from "./TopBar.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const accounts = useAccounts();
  const summary = useQueueSummary();
  const cleanup = useCleanup();
  const wide = useMediaQuery(BP.lg);
  const now = useNow();
  const count = summary.data?.groups ?? null;
  const items: NavItem[] = [
    {
      to: "/review",
      label: "Review",
      icon: "review",
      count,
      progressLabel: cleanup.progressLabel,
      shortcut: "G R",
    },
    { to: "/activity", label: "Activity", icon: "activity", shortcut: "G A" },
    { to: "/insights", label: "Insights", icon: "insights", shortcut: "G I" },
    { to: "/rules", label: "Rules", icon: "rules", shortcut: "G U" },
  ];
  const list = accounts.data?.accounts ?? [];
  const owner = me.data?.email ?? "";
  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[var(--layout-sidebar)_minmax(0,1fr)]">
      <a
        href="#main"
        className={`sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-(--z-skiplink) ${buttonClass("secondary", "md")}`}
      >
        Skip to content
      </a>
      {wide ? (
        <aside className="sticky top-0 h-dvh overflow-y-auto border-r border-line bg-surface-sunk px-2.5 pt-3.5 pb-2.5">
          <SidebarNav
            items={items}
            accounts={list}
            ownerEmail={owner}
            variant="rail"
            loading={me.isPending || accounts.isPending}
            now={now}
          />
        </aside>
      ) : (
        <TopBar items={items} accounts={list} ownerEmail={owner} reviewCount={count} now={now} />
      )}
      <main id="main" tabIndex={-1} className="min-w-0 px-[22px] pt-[18px] pb-[22px] focus:outline-none">
        {children}
      </main>
    </div>
  );
}
