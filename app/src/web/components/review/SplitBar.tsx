import { cssVars } from "../ui/css-vars.ts";

export interface SplitSegment {
  key: string;
  className: string;
  value: number;
  legend: string;
}

/** The bar is decorative; the legend states every number (UI spec 4.5, 7.2 exemption). */
export function SplitBar({ segments }: { segments: readonly SplitSegment[] }) {
  const shown = segments.filter((s) => s.value > 0);
  return (
    <>
      <div
        aria-hidden="true"
        className="mt-2.5 flex h-1.5 w-[340px] max-w-full gap-0.5 overflow-hidden rounded-xs"
      >
        {shown.map((s) => (
          <i
            key={s.key}
            className={`cb-grow block h-full ${s.className}`}
            style={cssVars({ "--cb-grow": s.value })}
          />
        ))}
      </div>
      <ul aria-label="Clean up split" className="mt-[7px] flex flex-wrap gap-3.5 text-meta text-ink-2">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-[5px]">
            <i aria-hidden="true" className={`size-[7px] rounded-[2px] ${s.className}`} />
            {s.legend}
          </li>
        ))}
      </ul>
    </>
  );
}
