import type { AccountUiStatus } from "../../lib/view-types.ts";

const COLOR: Record<AccountUiStatus, string> = {
  up_to_date: "bg-status-ok",
  catching_up: "bg-status-sync",
  waiting: "bg-status-sync",
  paused: "bg-status-off",
  needs_reauth: "bg-status-warn",
  config_error: "bg-status-error",
};

export function StatusDot({ status }: { status: AccountUiStatus }) {
  return (
    <span aria-hidden="true" className={`inline-block size-[7px] shrink-0 rounded-full ${COLOR[status]}`} />
  );
}
