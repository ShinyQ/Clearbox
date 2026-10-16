import { useId } from "react";

/** The Clearbox AI spark: four-point star with the spark gradient (SVG, not CSS). */
export function Spark({ size = 14 }: { size?: 14 | 22 }) {
  const id = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="[stop-color:var(--color-spark-from)]" />
          <stop offset="1" className="[stop-color:var(--color-spark-to)]" />
        </linearGradient>
      </defs>
      <path d="M8 .5 9.8 6.2 15.5 8 9.8 9.8 8 15.5 6.2 9.8.5 8 6.2 6.2z" fill={`url(#${id})`} />
    </svg>
  );
}
