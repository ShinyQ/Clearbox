import type { Insights } from "../../../shared/api.ts";
import { formatCount, formatDayMonth } from "../../lib/format.ts";
import { cssVars } from "../ui/css-vars.ts";
import { SHIMMER } from "../ui/Skeleton.tsx";

export interface WeeklyChartProps {
  weeks: Insights["weekly"];
  state: "loading" | "ready" | "empty";
}

const SKELETON_HEIGHTS = ["h-[30%]", "h-[60%]", "h-[45%]", "h-[75%]", "h-[55%]", "h-[90%]"];

export function WeeklyChart({ weeks, state }: WeeklyChartProps) {
  if (state === "loading") {
    return (
      <div aria-hidden="true" className="flex h-[120px] items-end gap-1.5 px-4 pt-3.5 pb-1.5">
        {SKELETON_HEIGHTS.map((h) => (
          <span key={h} className={`flex-1 rounded-t-[4px] rounded-b-[2px] ${h} ${SHIMMER}`} />
        ))}
      </div>
    );
  }
  const max = Math.max(1, ...weeks.map((w) => w.cleaned));
  const label = (i: number, w: (typeof weeks)[number]) =>
    i === weeks.length - 1 ? "This week" : formatDayMonth(w.weekStart, true);
  const summary = weeks
    .map(
      (w, i) =>
        `${i === weeks.length - 1 ? "this week" : formatDayMonth(w.weekStart, true)} ${formatCount(w.cleaned)}`,
    )
    .join(", ");
  const last = weeks[weeks.length - 1];
  return (
    <>
      <div
        role="group"
        aria-label={`Emails cleaned per week: ${summary}`}
        className="flex h-[120px] items-end gap-1.5 px-4 pt-3.5 pb-1.5"
      >
        {weeks.map((w, i) => (
          <div key={w.weekStart} className="group relative flex h-full flex-1 items-end">
            <span
              role="img"
              tabIndex={0}
              aria-label={`${label(i, w)}: ${formatCount(w.cleaned)} cleaned, ${formatCount(w.undone)} undone`}
              className={`cb-bar-height block min-h-[2px] w-full rounded-t-[4px] rounded-b-[2px] outline-offset-2 ${i === weeks.length - 1 ? "bg-accent" : "bg-accent-bar"}`}
              style={cssVars({ "--cb-value": w.cleaned / max })}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 rounded-sm bg-inverse px-1.5 py-0.5 text-meta whitespace-nowrap text-on-inverse group-focus-within:block group-hover:block"
            >
              {`${formatCount(w.cleaned)} cleaned · ${formatCount(w.undone)} undone`}
            </span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-1.5 px-4 text-meta text-ink-3">
        {weeks.map((w, i) => (
          <span key={w.weekStart} className="flex-1 text-center">
            {label(i, w)}
          </span>
        ))}
      </div>
      <p className="px-4 pt-1 pb-3 text-small text-ink-3">
        {state === "empty" || !last
          ? "No Clean ups yet. Your first one will show up here."
          : `This week: ${formatCount(last.cleaned)} cleaned, ${formatCount(last.undone)} undone`}
      </p>
      <table className="sr-only">
        <caption>Emails cleaned per week</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Cleaned</th>
            <th scope="col">Undone</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.weekStart}>
              <td>{label(i, w)}</td>
              <td>{formatCount(w.cleaned)}</td>
              <td>{formatCount(w.undone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
