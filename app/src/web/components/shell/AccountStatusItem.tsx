import { Link } from "react-router";
import type { AccountView } from "../../../shared/api.ts";
import { minutesUntil, providerName } from "../../lib/account-status.ts";
import type { AccountUiStatus } from "../../lib/view-types.ts";
import { StatusDot } from "./StatusDot.tsx";

export interface AccountStatusItemProps {
  account: AccountView;
  status: AccountUiStatus;
  catchUpPercent: number | null;
  variant: "sidebar" | "inline";
  now: number;
  onReconnect: (account: AccountView) => void;
}

export const INLINE_TEXT = (status: AccountUiStatus, account: AccountView): string =>
  ({
    up_to_date: "Up to date",
    catching_up: "Catching up",
    waiting: `Waiting for ${providerName(account.provider)}`,
    paused: "Paused",
    needs_reauth: "Needs reconnect",
    config_error: "Setup error",
  })[status];

export function accountAccessibleName(
  p: Pick<AccountStatusItemProps, "account" | "status" | "catchUpPercent" | "now">,
): string {
  const { email, sync } = p.account;
  switch (p.status) {
    case "up_to_date":
      return `${email}, up to date`;
    case "catching_up":
      return p.catchUpPercent === null
        ? `${email}, catching up`
        : `${email}, catching up, ${p.catchUpPercent}% sorted`;
    case "waiting":
      return `${email}, waiting for the provider, retrying in ${sync.backoffUntil ? minutesUntil(sync.backoffUntil, p.now) : 1} min`;
    case "paused":
      return `${email}, paused`;
    case "needs_reauth":
      return `${email}, needs reconnect`;
    case "config_error":
      return `${email}, setup error`;
  }
}

function trailingText(status: AccountUiStatus, percent: number | null): string | null {
  if (status === "catching_up") return percent === null ? "Sorting" : `${percent}%`;
  if (status === "waiting") return "Waiting";
  if (status === "paused") return "Paused";
  return null;
}

export function AccountStatusItem(p: AccountStatusItemProps) {
  if (p.variant === "inline") {
    return (
      <span className="inline-flex items-center gap-2">
        <StatusDot status={p.status} />
        {INLINE_TEXT(p.status, p.account)}
      </span>
    );
  }
  const hash = `/accounts#acc_${p.account.id}`;
  const trailing = trailingText(p.status, p.catchUpPercent);
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-[5px] text-body text-ink-2 hover:bg-[rgba(22,23,27,.04)]">
      <Link
        to={hash}
        aria-label={accountAccessibleName(p)}
        className="flex min-w-0 flex-1 items-center gap-2 outline-offset-[-2px]"
      >
        <StatusDot status={p.status} />
        <span className="truncate" title={p.account.email}>
          {p.account.email}
        </span>
      </Link>
      {trailing ? (
        <span aria-hidden="true" className="text-small text-ink-3">
          {trailing}
        </span>
      ) : null}
      {p.status === "needs_reauth" ? (
        <button
          type="button"
          aria-label={`Reconnect ${p.account.email}`}
          onClick={() => p.onReconnect(p.account)}
          className="text-small text-ink-2 hover:underline"
        >
          Reconnect
        </button>
      ) : null}
      {p.status === "config_error" ? (
        <Link to={hash} className="text-small text-ink-2 hover:underline">
          Fix setup
        </Link>
      ) : null}
    </li>
  );
}
