import { Link, NavLink } from "react-router";
import type { AccountView } from "../../../shared/api.ts";
import { catchUpFraction, deriveAccountUiStatus } from "../../lib/account-status.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { browser, SIGN_OUT_URL } from "../../lib/links.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { Menu } from "../ui/Menu.tsx";
import { SHIMMER } from "../ui/Skeleton.tsx";
import { AccountStatusItem } from "./AccountStatusItem.tsx";

export interface NavItem {
  to: "/review" | "/activity" | "/insights" | "/rules";
  label: "Review" | "Activity" | "Insights" | "Rules";
  icon: IconName;
  count?: number | null;
  progressLabel?: string | null;
  shortcut: string;
}

export interface SidebarNavProps {
  items: readonly NavItem[];
  accounts: readonly AccountView[];
  ownerEmail: string;
  variant: "rail" | "drawer";
  loading?: boolean;
  now: number;
  onNavigate?: (() => void) | undefined;
}

const ITEM = "flex h-[30px] items-center gap-[9px] rounded-md px-2 py-1.5 text-body outline-offset-[-2px]";
const HOVER = "hover:bg-[rgba(22,23,27,.04)]";

function navLabel(item: NavItem): string | undefined {
  if (item.progressLabel) return `${item.label}, Clean up ${item.progressLabel} done`;
  if (item.count) return `${item.label}, ${plural(item.count, "group", "groups")} to review`;
  return undefined;
}

export function Brand() {
  return (
    <Link
      to="/review"
      className="flex items-center gap-[9px] px-2 pt-1 pb-3.5 text-title-sm font-heading text-ink"
    >
      <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-ink text-white">
        <Icon name="review" size={14} strokeWidth={2} />
      </span>
      Clearbox
    </Link>
  );
}

function AccountsList({
  accounts,
  now,
  onNavigate,
}: Pick<SidebarNavProps, "accounts" | "now" | "onNavigate">) {
  return (
    <nav aria-label="Accounts">
      <Link
        to="/accounts"
        onClick={onNavigate}
        className="block px-2 pt-4 pb-1.5 text-meta text-ink-3 hover:text-ink-2 hover:underline"
      >
        Accounts
      </Link>
      <ul className="flex flex-col">
        {accounts.slice(0, 6).map((a) => {
          const fraction = catchUpFraction(a);
          return (
            <AccountStatusItem
              key={a.id}
              account={a}
              status={deriveAccountUiStatus(a, now)}
              catchUpPercent={fraction === null ? null : Math.floor(fraction * 100)}
              variant="sidebar"
              now={now}
              onReconnect={(acc) => startOAuth(acc.provider, { returnTo: "/accounts", loginHint: acc.email })}
            />
          );
        })}
      </ul>
      {accounts.length > 6 ? (
        <Link to="/accounts" className="block px-2 py-1 text-small text-ink-3 hover:underline">
          {`${accounts.length - 6} more`}
        </Link>
      ) : null}
    </nav>
  );
}

function UserMenu({ ownerEmail }: { ownerEmail: string }) {
  const { setHelpOpen } = useHotkeysControl();
  return (
    <Menu
      label="Account menu"
      placement="above"
      items={[
        { id: "keys", label: "Keyboard shortcuts", icon: "question", onSelect: () => setHelpOpen(true) },
        {
          id: "signout",
          label: "Sign out",
          icon: "arrow-left",
          onSelect: () => browser.assign(SIGN_OUT_URL),
        },
      ]}
      renderTrigger={(t) => (
        <button
          {...t}
          type="button"
          aria-label={`Account menu for ${ownerEmail}`}
          className={`flex w-full items-center gap-2 rounded-md p-2 text-left text-small text-ink-2 ${HOVER}`}
        >
          <span
            aria-hidden="true"
            className="grid size-[22px] place-items-center rounded-full bg-neutral-fill text-micro font-heavy text-ink"
          >
            {(ownerEmail[0] ?? "?").toUpperCase()}
          </span>
          <span className="truncate" title={ownerEmail}>
            {ownerEmail}
          </span>
        </button>
      )}
    />
  );
}

export function SidebarNav({
  items,
  accounts,
  ownerEmail,
  loading = false,
  now,
  onNavigate,
}: SidebarNavProps) {
  return (
    <div className="flex h-full flex-col gap-0.5">
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        <Brand />
        {loading
          ? Array.from({ length: 4 }, (_, i) => (
              <span key={i} aria-hidden="true" className={`mx-2 my-[9px] h-3 rounded-xs ${SHIMMER}`} />
            ))
          : items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.shortcut}
                aria-label={navLabel(item)}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `${ITEM} ${isActive ? "bg-surface font-emphasis text-ink shadow-nav [&_svg]:opacity-100" : `text-ink-2 ${HOVER} active:bg-[rgba(22,23,27,.06)] [&_svg]:opacity-70`}`
                }
              >
                <Icon name={item.icon} size={15} />
                {item.label}
                {item.progressLabel || item.count ? (
                  <span className="ml-auto text-meta text-ink-3">
                    {item.progressLabel ?? formatCount(item.count ?? 0)}
                  </span>
                ) : null}
              </NavLink>
            ))}
        <Link to="/accounts?add=1" onClick={onNavigate} className={`${ITEM} mt-1 text-ink-2 ${HOVER}`}>
          <Icon name="plus" size={15} className="opacity-70" />
          Add account
        </Link>
      </nav>
      <AccountsList accounts={accounts} now={now} onNavigate={onNavigate} />
      <div className="mt-auto">
        <UserMenu ownerEmail={ownerEmail} />
      </div>
    </div>
  );
}
