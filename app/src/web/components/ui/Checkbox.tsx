import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "./icons.tsx";

export interface CheckboxProps {
  checked: boolean | "mixed";
  onChange: (next: boolean, e: MouseEvent | KeyboardEvent) => void;
  label: string;
  tabIndex?: 0 | -1;
  disabled?: boolean;
}

/** Native checkbox styled directly (appearance: none); mixed uses the indeterminate property. */
export function Checkbox({ checked, onChange, label, tabIndex = 0, disabled = false }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "mixed";
  }, [checked]);
  const on = checked !== false;
  return (
    <span className="relative inline-grid size-[15px] shrink-0 place-items-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked === true}
        disabled={disabled}
        tabIndex={tabIndex}
        onChange={() => undefined}
        onClick={(e) => {
          e.stopPropagation();
          onChange(checked !== true, e);
        }}
        className={`size-[15px] cursor-pointer appearance-none rounded-xs border-[1.5px] transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-45 ${
          on ? "border-ink bg-ink" : "border-line-control bg-surface hover:border-ink-3"
        }`}
      />
      {checked === true ? (
        <Icon name="check" size={11} strokeWidth={2} className="pointer-events-none absolute text-white" />
      ) : null}
      {checked === "mixed" ? (
        <span aria-hidden="true" className="pointer-events-none absolute h-[2px] w-2 rounded-full bg-white" />
      ) : null}
    </span>
  );
}
