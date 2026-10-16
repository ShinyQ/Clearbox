import { useRef, useState } from "react";
import type { AccountView } from "../../../shared/api.ts";
import {
  backlogRemaining,
  catchUpFraction,
  deriveAccountUiStatus,
  etaText,
  minutesUntil,
  providerName,
} from "../../lib/account-status.ts";
import { formatCount, formatDayMonth } from "../../lib/format.ts";
import { useScanNow } from "../../pages/review/use-scan-now.ts";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { Button } from "../ui/Button.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { DisconnectConfirm } from "./DisconnectConfirm.tsx";
import { ProviderTile } from "./ProviderTile.tsx";

export function accountStatusLine(a: AccountView, now: number, dailyRate: number): string {
  const p = providerName(a.provider);
  const connected = `connected ${formatDayMonth(a.createdAt)}`;
  const sorted = formatCount(a.sync.messagesIngested);
  const status = deriveAccountUiStatus(a, now);
  let line: string;
  if (status === "up_to_date") line = `${p} · up to date · ${sorted} emails sorted · ${connected}`;
  else if (status === "catching_up") {
    const left = backlogRemaining(a);
    line =
      left === null
        ? `${p} · catching up, ${sorted} sorted so far · ${connected}`
        : `${p} · catching up, ${formatCount(left)} left (${etaText(left, dailyRate)}) · ${connected}`;
  } else if (status === "waiting") {
    line = `${p} · waiting, ${p} asked Clearbox to slow down · retrying in ${a.sync.backoffUntil ? minutesUntil(a.sync.backoffUntil, now) : 1} min`;
  } else if (status === "paused") line = `${p} · paused by you · ${sorted} emails sorted`;
  else if (status === "needs_reauth") line = `${p} · paused, needs reconnect`;
  else line = `${p} · paused, sign-in setup error (${a.statusReason ?? "unknown"})`;
  return a.archiveSupported ? line : `${line} · Archive unavailable, archive suggestions are kept in Review`;
}

export interface AccountCardProps {
  account: AccountView;
  now: number;
  dailyRate: number;
  disconnecting: boolean;
  onPause: (paused: boolean) => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

interface CardAction {
  id: string;
  label: string;
  primary: boolean;
  run: () => void;
}

export function AccountCard({
  account: a,
  now,
  dailyRate,
  disconnecting,
  onPause,
  onDisconnect,
  onReconnect,
}: AccountCardProps) {
  const status = deriveAccountUiStatus(a, now);
  const [confirming, setConfirming] = useState(false);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const wide = useMediaQuery(BP.lg);
  const scan = useScanNow([a], a.id);
  const fraction = catchUpFraction(a);
  const running = status === "up_to_date" || status === "catching_up";
  const actions: CardAction[] = [];
  if (running) actions.push({ id: "scan", label: "Scan now", primary: false, run: () => void scan.run() });
  if (running || status === "waiting")
    actions.push({ id: "pause", label: "Pause", primary: false, run: () => onPause(true) });
  if (status === "paused") actions.push({ id: "resume", label: "Resume", primary: true, run: () => onPause(false) });
  if (status === "needs_reauth" || status === "config_error")
    actions.push({ id: "reconnect", label: "Reconnect", primary: true, run: onReconnect });
  actions.push({ id: "disconnect", label: "Disconnect", primary: false, run: () => setConfirming(true) });

  const items: MenuItem[] = actions.map((x) => ({
    id: x.id,
    label: x.label,
    destructive: x.id === "disconnect",
    onSelect: x.run,
  }));
  return (
    <div
      id={`acc_${a.id}`}
      tabIndex={-1}
      role="group"
      aria-label={a.email}
      className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-subtle px-4 py-3.5 outline-offset-[-2px] last:border-b-0"
    >
      <ProviderTile provider={a.provider} active={running} />
      <div className="min-w-0">
        <p className="truncate font-emphasis text-ink">{a.email}</p>
        <p className="text-small text-ink-3">{accountStatusLine(a, now, dailyRate)}</p>
        {status === "catching_up" ? (
          <div className="mt-1.5">
            <ProgressBar value={fraction} tone="archive" width={240} label={`Sorting progress for ${a.email}`} />
          </div>
        ) : null}
      </div>
      {wide ? (
        <div className="flex items-center gap-1.5">
          {actions.map((x) => (
            <Button
              key={x.id}
              ref={x.id === "disconnect" ? disconnectRef : undefined}
              variant={x.primary ? "secondary" : "ghost"}
              size="sm"
              aria-label={`${x.label} ${a.email}`}
              loading={x.id === "scan" ? scan.scanning : undefined}
              loadingLabel="Scanning…"
              onClick={x.run}
            >
              {x.label}
            </Button>
          ))}
        </div>
      ) : (
        <Menu
          label={`Account actions for ${a.email}`}
          align="end"
          items={items}
          renderTrigger={(t) => (
            <Button {...t} variant="ghost" size="sm" icon="more" aria-label={`Account actions for ${a.email}`} />
          )}
        />
      )}
      {confirming ? (
        <DisconnectConfirm
          email={a.email}
          busy={disconnecting}
          onCancel={() => {
            setConfirming(false);
            requestAnimationFrame(() => disconnectRef.current?.focus());
          }}
          onConfirm={onDisconnect}
        />
      ) : null}
    </div>
  );
}
