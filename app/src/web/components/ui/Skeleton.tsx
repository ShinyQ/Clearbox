import { cssVars } from "./css-vars.ts";

export const SHIMMER =
  "bg-[linear-gradient(90deg,var(--color-surface-sunk),var(--color-skeleton-highlight),var(--color-surface-sunk))] bg-[length:200%_100%] motion-safe:animate-shimmer motion-reduce:bg-none motion-reduce:bg-surface-sunk";

const HEIGHT = { 6: "h-1.5", 10: "h-2.5", 14: "h-3.5" } as const;

export function SkeletonLine({ width, height = 10 }: { width: number | `${number}%`; height?: 6 | 10 | 14 }) {
  const w = typeof width === "number" ? `${width}px` : width;
  return (
    <span
      aria-hidden="true"
      className={`block max-w-full w-(--cb-w) rounded-xs ${HEIGHT[height]} ${SHIMMER}`}
      style={cssVars({ "--cb-w": w })}
    />
  );
}

/** Same grid and padding as SenderGroupRow so nothing shifts when data arrives. */
export function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="grid min-h-14 grid-cols-[22px_minmax(0,1fr)_92px_108px_44px] items-center gap-2.5 border-b border-line-subtle px-3.5 py-2.5"
        >
          <span className={`size-[15px] rounded-xs ${SHIMMER}`} />
          <span className="flex items-center gap-[9px]">
            <span className={`size-[22px] shrink-0 rounded-sm ${SHIMMER}`} />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <SkeletonLine width={140} />
              <SkeletonLine width={220} height={6} />
            </span>
          </span>
          <span className={`h-[18px] w-16 rounded-sm ${SHIMMER}`} />
          <span className="flex flex-col gap-1.5">
            <SkeletonLine width={80} />
            <span className={`h-1 w-full rounded-xs ${SHIMMER}`} />
          </span>
          <span className="ml-auto">
            <SkeletonLine width={24} />
          </span>
        </div>
      ))}
    </div>
  );
}
