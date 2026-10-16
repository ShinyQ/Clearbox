import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string | undefined;
}

/** Native modal dialog (UI spec 4.33); focus goes to the title and returns to the opener. */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      dialog.querySelector<HTMLElement>("h2")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnTo.current?.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`z-(--z-dialog) m-auto w-[520px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-5 text-ink shadow-overlay backdrop:bg-[rgba(16,17,22,.32)] ${className ?? ""}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 id={titleId} tabIndex={-1} className="text-title font-semibold outline-none">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon="close"
          aria-label="Close"
          className="ml-auto"
          onClick={onClose}
        />
      </div>
      {children}
    </dialog>
  );
}
