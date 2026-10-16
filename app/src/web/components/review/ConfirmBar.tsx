import { useEffect, useId, useRef, type RefObject } from "react";
import { enterKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { Button } from "../ui/Button.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { Spark } from "../ui/Spark.tsx";

export type ConfirmBarMode = "cleanup" | "confirm_keeps";

export interface ConfirmBarProps {
  mode: ConfirmBarMode;
  phase: "confirming" | "running" | "partial";
  title: string;
  detail: string;
  processed?: number | undefined;
  total?: number | undefined;
  stopping?: boolean | undefined;
  platform: Platform;
  extraAction?: { label: string; onClick: () => void } | undefined;
  confirmRef?: RefObject<HTMLButtonElement | null> | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  onStop: () => void;
  onRetry: () => void;
}

/** Inline, non-modal confirmation and progress for Clean up (UI spec 4.16). */
export function ConfirmBar(p: ConfirmBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLButtonElement>(null);
  const confirmRef = p.confirmRef ?? ownRef;
  const detailId = useId();
  const confirming = p.phase === "confirming";
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming, confirmRef]);
  useHotkeys(
    "confirm",
    [
      {
        combo: "enter",
        handler: () => {
          const active = document.activeElement;
          if (
            !active ||
            active === document.body ||
            active === rootRef.current ||
            active === confirmRef.current
          ) {
            p.onConfirm();
          } else if (rootRef.current?.contains(active) && active instanceof HTMLButtonElement) {
            // Enter on another bar button runs that button, never the destructive default.
            active.click();
          }
        },
      },
      { combo: "escape", handler: () => p.onCancel() },
    ],
    confirming,
  );
  const value = p.total ? (p.processed ?? 0) / p.total : 0;
  return (
    <div
      ref={rootRef}
      data-inverse
      role="region"
      aria-label={p.mode === "confirm_keeps" ? "Confirm all keeps" : "Clean up"}
      className="cb-bar sticky bottom-4 z-(--z-confirm) mt-3.5 flex items-center gap-3.5 rounded-xl bg-inverse py-3 pr-3.5 pl-[18px] text-on-inverse shadow-bar motion-safe:animate-[cb-toast-in_250ms_var(--ease-out)]"
    >
      <Spark size={14} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{p.title}</p>
        {p.phase === "running" ? (
          <div className="mt-2">
            <ProgressBar
              value={value}
              tone="on-inverse"
              label={p.mode === "confirm_keeps" ? "Confirm keeps progress" : "Clean up progress"}
              valueText={p.title}
            />
          </div>
        ) : (
          <p id={detailId} className="text-small text-on-inverse-3">
            {p.detail}
          </p>
        )}
      </div>
      {confirming ? (
        <>
          <Button variant="on-inverse-ghost" kbd={["Esc"]} aria-keyshortcuts="Escape" onClick={p.onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant="on-inverse"
            kbd={[enterKey(p.platform)]}
            aria-keyshortcuts="Enter"
            aria-describedby={detailId}
            onClick={p.onConfirm}
          >
            {p.mode === "confirm_keeps" ? "Confirm" : "Clean up"}
          </Button>
        </>
      ) : null}
      {p.phase === "running" ? (
        <>
          <span className="hidden text-small text-on-inverse-3 sm:inline">You can keep reviewing</span>
          <Button variant="on-inverse-ghost" loading={p.stopping} loadingLabel="Stopping…" onClick={p.onStop}>
            Stop
          </Button>
        </>
      ) : null}
      {p.phase === "partial" ? (
        <>
          {p.extraAction ? (
            <Button variant="on-inverse" onClick={p.extraAction.onClick}>
              {p.extraAction.label}
            </Button>
          ) : null}
          <Button variant="on-inverse" onClick={p.onRetry}>
            Try again
          </Button>
          <Button variant="on-inverse-ghost" onClick={p.onCancel}>
            Dismiss
          </Button>
        </>
      ) : null}
    </div>
  );
}
