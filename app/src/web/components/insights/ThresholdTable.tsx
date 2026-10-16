import type { Insights } from "../../../shared/api.ts";
import { toPercent } from "../../lib/confidence.ts";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { Icon } from "../ui/icons.tsx";
import { Table } from "../ui/Table.tsx";

type Point = Insights["calibration"]["points"][number];

export function ThresholdTable({ calibration }: { calibration: Insights["calibration"] }) {
  const current = toPercent(calibration.tauDelete);
  return (
    <details className="group mt-3.5 rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-semibold text-ink">
        How the threshold was chosen
        <Icon
          name="chevron-down"
          size={14}
          className="text-ink-3 motion-safe:transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-line">
        <p className="px-4 py-3 text-small text-ink-3">
          Each row shows how often you agreed with trash suggestions at that threshold. Clearbox picks the
          lowest threshold with at least 20 decisions and 98% agreement.
        </p>
        <Table<Point>
          caption="Threshold calibration"
          state={calibration.points.length === 0 ? "empty" : "ready"}
          emptyText="Not enough decisions yet."
          rows={calibration.points}
          rowKey={(p) => p.tau}
          columns={[
            {
              key: "tau",
              header: "Threshold",
              render: (p) => (
                <span className="inline-flex items-center gap-2">
                  {`${toPercent(p.tau)}%`}
                  {toPercent(p.tau) === current ? (
                    <span className="rounded-sm bg-surface-sunk px-1.5 text-meta font-emphasis text-ink-2">
                      Current
                    </span>
                  ) : null}
                </span>
              ),
            },
            { key: "support", header: "Decisions", align: "right", render: (p) => formatCount(p.support) },
            {
              key: "precision",
              header: "Agreement",
              render: (p) => (p.precision === null ? "n/a" : formatPercent(p.precision, 1)),
            },
          ]}
        />
      </div>
    </details>
  );
}
