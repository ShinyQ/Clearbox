import { BAND_FILL } from "../../lib/confidence.ts";
import type { Band } from "../../lib/view-types.ts";
import { cssVars } from "../ui/css-vars.ts";

export interface ConfidenceMeterProps {
  value: number;
  band: Band;
  tau: number | null;
  height?: 4 | 6;
  tone?: "band" | "accent" | "archive";
  empty?: boolean;
}

/** Supplementary graphic; the adjacent label carries the information (UI spec 4.11). */
export function ConfidenceMeter({
  value,
  band,
  tau,
  height = 4,
  tone = "band",
  empty = false,
}: ConfidenceMeterProps) {
  const fill = tone === "band" ? BAND_FILL[band] : tone === "accent" ? "bg-accent" : "bg-archive";
  return (
    <span
      aria-hidden="true"
      className={`cb-meter relative block rounded-xs bg-track ${height === 6 ? "h-1.5" : "h-1"}`}
      style={cssVars({ "--cb-value": empty ? 0 : value, "--cb-tau": tau ?? 0 })}
    >
      <i
        className={`cb-fill block h-full rounded-xs ${fill} motion-safe:transition-[width] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-standard)`}
      />
      {tau !== null ? (
        <i className="cb-tick absolute -top-[3px] -bottom-[3px] w-[1.5px] -translate-x-1/2 rounded-[1px] bg-tick" />
      ) : null}
    </span>
  );
}
