import { cssVars } from "./css-vars.ts";

export interface ProgressBarProps {
  value: number | null;
  tone: "on-inverse" | "accent" | "archive" | "ink";
  height?: 4 | 6;
  label: string;
  valueText?: string | undefined;
  width?: "full" | 240;
}

const FILL = {
  "on-inverse": "bg-on-inverse",
  accent: "bg-accent",
  archive: "bg-archive",
  ink: "bg-ink",
} as const;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function ProgressBar({ value, tone, height = 4, label, valueText, width = "full" }: ProgressBarProps) {
  const track = tone === "on-inverse" ? "bg-inverse-track" : "bg-track";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(clamp(value) * 100)}
      aria-valuetext={valueText}
      className={`cb-meter relative overflow-hidden rounded-xs ${track} ${height === 6 ? "h-1.5" : "h-1"} ${
        width === 240 ? "w-[240px] max-w-full" : "w-full"
      }`}
    >
      {value === null ? (
        <i
          className={`absolute inset-y-0 left-0 w-[30%] rounded-xs ${FILL[tone]} motion-safe:animate-[cb-indeterminate_1.2s_var(--ease-standard)_infinite]`}
        />
      ) : (
        <i
          className={`cb-fill block h-full rounded-xs ${FILL[tone]} motion-safe:transition-[width] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-standard)`}
          style={cssVars({ "--cb-value": clamp(value) })}
        />
      )}
    </div>
  );
}
