import { useRef, useState } from "react";
import { useLocation } from "react-router";
import type { AccountView } from "../../../shared/api.ts";
import { formatCount } from "../../lib/format.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { useFocusTrap } from "../../state/use-focus-trap.ts";
import { Button } from "../ui/Button.tsx";
import { Brand, SidebarNav, type NavItem } from "./SidebarNav.tsx";

export interface TopBarProps {
  items: readonly NavItem[];
  accounts: readonly AccountView[];
  ownerEmail: string;
  reviewCount: number | null;
  now: number;
}

/** Below 1024px the sidebar becomes a 48px top bar plus a modal drawer (UI spec 2.8). */
export function TopBar({ items, accounts, ownerEmail, reviewCount, now }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const { key } = useLocation();
  const [seenKey, setSeenKey] = useState(key);
  // Any navigation, from any link in the drawer, closes it (UI spec 4.2).
  if (seenKey !== key) {
    setSeenKey(key);
    if (open) setOpen(false);
  }
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    menuRef.current?.focus();
  };
  useHotkeys("dialog", [{ combo: "escape", handler: close }], open);
  useFocusTrap(drawerRef, open);
  return (
    <>
      <header className="sticky top-0 z-(--z-sticky) flex h-12 items-center gap-2 border-b border-line bg-surface-sunk px-2.5">
        <Button
          ref={menuRef}
          variant="ghost"
          size="sm"
          icon="menu"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
        <Brand />
        {reviewCount ? (
          <span className="ml-auto text-meta text-ink-3">{`${formatCount(reviewCount)} to review`}</span>
        ) : null}
      </header>
      {open ? (
        <div className="fixed inset-0 z-(--z-drawer)">
          <div aria-hidden="true" className="absolute inset-0 bg-[rgba(16,17,22,.32)]" onClick={close} />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 w-(--layout-sidebar) overflow-y-auto bg-surface-sunk px-2.5 pt-3.5 pb-2.5 shadow-overlay motion-safe:animate-[cb-fade-in_250ms_var(--ease-out)]"
          >
            <Button
              variant="ghost"
              size="sm"
              icon="close"
              aria-label="Close navigation"
              className="mb-1"
              onClick={close}
            />
            <SidebarNav
              items={items}
              accounts={accounts}
              ownerEmail={ownerEmail}
              variant="drawer"
              now={now}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
