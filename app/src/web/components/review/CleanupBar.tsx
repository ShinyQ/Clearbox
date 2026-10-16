import { useEffect } from "react";
import { processedOf } from "../../api/cleanup.ts";
import {
  confirmDetail,
  confirmTitle,
  partialCopy,
  runningTitle,
  STOPPING_TITLE,
  type CopyContext,
} from "../../lib/copy.ts";
import type { Platform } from "../../lib/view-types.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { ConfirmBar } from "./ConfirmBar.tsx";

export interface CleanupBarProps {
  context: CopyContext;
  platform: Platform;
  onReconnect?: (() => void) | undefined;
}

export function CleanupBar({ context, platform, onReconnect }: CleanupBarProps) {
  const c = useCleanup();
  const announce = useAnnounce();
  const m = c.state.machine;
  const mode = c.state.mode;
  const partialTitle = m.phase === "partial" ? partialCopy(m.reason, m.run, context, mode).title : null;
  useEffect(() => {
    if (partialTitle) announce(partialTitle);
  }, [partialTitle, announce]);

  const common = { mode, platform, onConfirm: c.confirm, onStop: c.stop, onRetry: c.retry };
  if (m.phase === "confirming") {
    return (
      <ConfirmBar
        {...common}
        phase="confirming"
        title={confirmTitle(mode, m.preview, context)}
        detail={confirmDetail(mode, m.preview, context)}
        onCancel={c.cancel}
      />
    );
  }
  if (m.phase === "running") {
    const processed = processedOf(m.run);
    return (
      <ConfirmBar
        {...common}
        phase="running"
        processed={processed}
        total={m.run.total}
        stopping={m.stopRequested}
        title={m.stopRequested ? STOPPING_TITLE : runningTitle(mode, processed, m.run.total)}
        detail=""
        onCancel={c.cancel}
      />
    );
  }
  if (m.phase === "partial") {
    const copy = partialCopy(m.reason, m.run, context, mode);
    return (
      <ConfirmBar
        {...common}
        phase="partial"
        title={copy.title}
        detail={copy.detail}
        onCancel={c.dismiss}
        extraAction={
          m.reason === "account_inactive" && onReconnect
            ? { label: "Reconnect", onClick: onReconnect }
            : undefined
        }
      />
    );
  }
  return null;
}
