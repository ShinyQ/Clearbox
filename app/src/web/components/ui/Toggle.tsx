import { Icon } from "./icons.tsx";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  locked?: boolean;
  disabled?: boolean;
}

export function Toggle({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  locked = false,
  disabled = false,
}: ToggleProps) {
  const on = locked || checked;
  const inert = locked || disabled;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {locked ? <Icon name="lock" size={12} className="text-ink-3" /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-disabled={inert || undefined}
        onClick={() => {
          if (!inert) onChange(!checked);
        }}
        className={`relative h-[18px] w-[30px] rounded-full transition-colors duration-(--duration-fast) ${
          on ? "bg-ink" : "bg-line-control"
        } ${inert ? "cursor-not-allowed opacity-45" : "hover:opacity-90"}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 size-3.5 rounded-full bg-white motion-safe:transition-[left] motion-safe:duration-(--duration-fast) motion-safe:ease-out ${
            on ? "left-[14px]" : "left-0.5"
          }`}
        />
      </button>
    </span>
  );
}
