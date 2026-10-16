import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ariaMod, modKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { defaultDuration, type ToastItem } from "../../state/toast-queue.ts";
import { useToast, useToastList } from "../../state/ToastProvider.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./icons.tsx";
import { Kbd } from "./Kbd.tsx";
import { Spinner } from "./Spinner.tsx";

function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.hidden,
    () => false,
  );
}

/** Pausable countdown; restarts when `resetKey` changes (dedupe or update). */
function useToastTimer(duration: number | null, paused: boolean, onExpire: () => void, resetKey: number) {
  const remaining = useRef(duration);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  useEffect(() => {
    remaining.current = duration;
  }, [duration, resetKey]);
  useEffect(() => {
    if (duration === null || paused) return;
    const started = Date.now();
    const t = setTimeout(() => expire.current(), remaining.current ?? duration);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(0, (remaining.current ?? duration) - (Date.now() - started));
    };
  }, [duration, paused, resetKey]);
}

const ICON = { success: "success", info: "info", error: "alert" } as const;

export function ToastView({
  toast,
  platform,
  onDismiss,
}: {
  toast: ToastItem;
  platform: Platform;
  onDismiss: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [seen, setSeen] = useState({ busy: toast.busy, action: toast.action });
  if (seen.busy !== toast.busy || seen.action !== toast.action) {
    // A focused button that unmounts never fires blur, so reset when the controls change.
    setSeen({ busy: toast.busy, action: toast.action });
    setFocusWithin(false);
  }
  const hidden = useDocumentHidden();
  useToastTimer(
    toast.busy ? null : defaultDuration(toast),
    hover || focusWithin || hidden,
    () => onDismiss(toast.id),
    toast.createdAt,
  );
  const undo = toast.action?.shortcut === "mod+z";
  return (
    <div
      data-inverse
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      className={`cb-toast pointer-events-auto inline-flex max-w-[560px] items-center gap-3 rounded-lg bg-inverse py-[9px] pr-2.5 pl-3.5 text-body text-on-inverse shadow-toast motion-safe:animate-[cb-toast-in_250ms_var(--ease-out)] ${
        toast.leaving
          ? "translate-y-1 opacity-0 motion-safe:transition-[opacity,transform] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-in)"
          : ""
      }`}
    >
      {toast.busy ? <Spinner tone="on-dark" /> : <Icon name={ICON[toast.kind]} size={14} />}
      <span>{toast.message}</span>
      {toast.action && !toast.busy ? (
        <button
          type="button"
          onClick={toast.action.onAction}
          aria-keyshortcuts={undo ? `${ariaMod(platform)}+Z` : undefined}
          className="font-semibold underline underline-offset-2"
        >
          {toast.action.label}
        </button>
      ) : null}
      {undo && !toast.busy ? <Kbd keys={[modKey(platform), "Z"]} tone="on-inverse" ariaHidden /> : null}
      {undo && !toast.busy ? (
        <span className="sr-only">{`Press ${platform === "mac" ? "Command" : "Control"} Z to undo`}</span>
      ) : null}
      {!toast.busy && (toast.kind === "error" || hover || focusWithin) ? (
        <Button
          variant="on-inverse-ghost"
          size="sm"
          icon="close"
          aria-label="Dismiss notification"
          className="size-5 p-0"
          onClick={() => onDismiss(toast.id)}
        />
      ) : null}
    </div>
  );
}

/** Fixed region above everything (UI spec 4.18); raised above the ConfirmBar while it shows. */
export function ToastRegion({ raised }: { raised: boolean }) {
  const toasts = useToastList();
  const { dismiss } = useToast();
  const platform = usePlatform();
  const polite = toasts.filter((t) => t.kind !== "error");
  const errors = toasts.filter((t) => t.kind === "error");
  return (
    <div
      role="region"
      aria-label="Notifications"
      className={`pointer-events-none fixed inset-x-4 z-(--z-toast) flex flex-col items-stretch gap-2 sm:inset-x-0 sm:items-center lg:left-(--layout-sidebar) ${raised ? "bottom-24" : "bottom-6"}`}
    >
      <div aria-live="polite" className="flex flex-col items-stretch gap-2 sm:items-center">
        {polite.map((t) => (
          <ToastView key={t.id} toast={t} platform={platform} onDismiss={dismiss} />
        ))}
      </div>
      {errors.map((t) => (
        <div key={t.id} role="alert" className="flex justify-center">
          <ToastView toast={t} platform={platform} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
