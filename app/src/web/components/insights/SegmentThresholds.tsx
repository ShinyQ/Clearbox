import type { Insights } from "../../../shared/api.ts";
import { toPercent } from "../../lib/confidence.ts";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { Panel } from "../ui/Panel.tsx";
import { Table } from "../ui/Table.tsx";

type Segment = Insights["calibration"]["segments"][number];

export const SEGMENT_LABEL: Record<Segment["segment"], string> = {
  sender: "Senders you decided on before",
  domain: "Domains you decided on before",
  bulk: "Newsletters and bulk mail",
  other: "Everything else",
};

/** UI spec Insights, contracts 12.10: what a paused segment means, in one sentence. */
export function segmentNote(s: Segment): string {
  if (s.tauDelete === null) {
    const agreed =
      s.precisionAtTau === null ? "" : ` (you agreed ${formatPercent(s.precisionAtTau, 1)} of the time)`;
    return `Trash suggestions paused${agreed}: below the 98% target, so these go to Check instead.`;
  }
  if (s.outcome === "calibrated") return "Tuned nightly from your choices.";
  return `Not enough trash decisions here yet (${formatCount(s.deleteSuggestions)} of 50), so Clearbox stays careful.`;
}

/** Per-segment trash thresholds. Renders nothing before the first nightly segment calibration. */
export function SegmentThresholds({ segments }: { segments: Segment[] }) {
  if (segments.length === 0) return null;
  const paused = segments.filter((s) => s.tauDelete === null);
  return (
    <Panel
      className="mt-3.5"
      title="Trash thresholds by kind of email"
      meta={paused.length > 0 ? `${formatCount(paused.length)} paused` : "All active"}
    >
      <Table<Segment>
        caption="Trash thresholds by kind of email"
        state="ready"
        emptyText=""
        rows={segments}
        rowKey={(s) => s.segment}
        columns={[
          { key: "segment", header: "Kind of email", render: (s) => SEGMENT_LABEL[s.segment] },
          {
            key: "tau",
            header: "Threshold",
            render: (s) => (s.tauDelete === null ? "Paused" : `${toPercent(s.tauDelete)}%`),
          },
          { key: "note", header: "What it means", render: (s) => segmentNote(s) },
        ]}
      />
    </Panel>
  );
}
