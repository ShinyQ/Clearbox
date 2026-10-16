import { useId } from "react";
import { Icon } from "./icons.tsx";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string> {
  label: string;
  showLabel?: boolean;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  variant?: "default" | "ghost";
  disabled?: boolean;
  className?: string | undefined;
}

/** Styled native select (UI spec 4.24); the chevron is an SVG sibling, not a CSS background. */
export function Select<V extends string>({
  label,
  showLabel = false,
  value,
  options,
  onChange,
  variant = "default",
  disabled = false,
  className,
}: SelectProps<V>) {
  const id = useId();
  const box =
    variant === "ghost"
      ? "bg-transparent pl-1.5 pr-6 text-small text-ink-3 hover:text-ink-2"
      : "rounded-md border border-line bg-surface pl-2.5 pr-7 py-[5px] text-body text-ink-2 hover:border-neutral-fill";
  return (
    // Without a width from the caller the control hugs its content, so a stretching flex parent
    // never separates the chevron from the select box.
    <span className={`relative inline-flex max-w-full items-center ${className ?? "w-fit"}`}>
      <label htmlFor={id} className={showLabel ? "mr-2 text-meta text-ink-3" : "sr-only"}>
        {label}
      </label>
      <span className="relative inline-flex min-w-0 flex-1 items-center">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = options.find((o) => o.value === e.target.value);
            if (next) onChange(next.value);
          }}
          className={`h-[30px] w-full min-w-0 cursor-pointer appearance-none truncate disabled:cursor-not-allowed disabled:opacity-45 ${box}`}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-2 text-ink-3" />
      </span>
    </span>
  );
}
