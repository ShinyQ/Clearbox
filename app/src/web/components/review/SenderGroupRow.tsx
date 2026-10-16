import type { KeyboardEvent, MouseEvent } from "react";
import type { SenderGroup } from "../../../shared/api.ts";
import { bandFor, isModelUnavailable, membershipPhrase, toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { BAND_LABEL, VERDICT_LABEL } from "../../lib/view-types.ts";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { ConfidenceLabel } from "./ConfidenceLabel.tsx";
import { SenderAvatar } from "./SenderAvatar.tsx";
import { VerdictTag } from "./VerdictTag.tsx";

export const rowId = (key: string): string => `group-row-${key}`;

export function displayName(g: Pick<SenderGroup, "sender" | "senderName">): {
  text: string;
  unknown: boolean;
} {
  if (!g.sender) return { text: "Unknown sender", unknown: true };
  const name = g.senderName?.trim();
  return { text: name && name !== g.sender ? name : g.sender, unknown: false };
}

export function rowAriaLabel(g: SenderGroup, tau: number): string {
  const unavailable = isModelUnavailable(g);
  const band = unavailable ? "unsure" : bandFor(g.confidence.avg, tau, g.action);
  const confidence = unavailable
    ? "confidence not available"
    : `${toPercent(g.confidence.avg)}% ${BAND_LABEL[band]}`;
  const parts = [
    displayName(g).text,
    VERDICT_LABEL[g.action],
    confidence,
    membershipPhrase(g.action, band),
    plural(g.count, "email", "emails"),
  ];
  if (g.ceilingApplied) parts.push("protected by a guardrail");
  return parts.join(", ");
}

export interface SenderGroupRowProps {
  group: SenderGroup;
  tau: number;
  rowIndex: number;
  active: boolean;
  selected: boolean;
  busy: boolean;
  exiting: boolean;
  focusable: boolean;
  accountEmail: string | null;
  onClick: (e: MouseEvent) => void;
  onCheckboxChange: (next: boolean, e: MouseEvent | KeyboardEvent) => void;
}

const GRID = "grid-cols-[22px_minmax(0,1fr)_auto] sm:grid-cols-[22px_minmax(0,1fr)_92px_108px_44px]";
const EXIT =
  "max-h-0 min-h-0 overflow-hidden border-b-0 py-0 opacity-0 motion-safe:transition-[opacity,max-height,padding] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-in) motion-safe:[transition-delay:0ms,200ms,200ms]";

export function SenderGroupRow(p: SenderGroupRowProps) {
  const { group: g } = p;
  const name = displayName(g);
  const unavailable = isModelUnavailable(g);
  const second = g.latestSubject ?? g.topReasons[0]?.text ?? "";
  const tint = p.active || p.selected ? "bg-surface-selected" : "bg-surface hover:bg-surface-hover";
  return (
    <div
      role="row"
      id={rowId(g.key)}
      data-group-key={g.key}
      aria-rowindex={p.rowIndex + 2}
      aria-selected={p.selected}
      aria-current={p.active ? "true" : undefined}
      aria-busy={p.busy || undefined}
      aria-label={rowAriaLabel(g, p.tau)}
      tabIndex={p.focusable ? 0 : -1}
      onClick={p.onClick}
      className={`cb-row grid min-h-14 max-h-40 cursor-pointer items-center gap-x-2.5 gap-y-1 border-b border-line-subtle px-3.5 py-2.5 outline-offset-[-2px] transition-colors duration-(--duration-fast) ${GRID} ${tint} ${
        p.busy ? "[&>*]:opacity-60" : ""
      } ${p.exiting ? EXIT : ""}`}
    >
      <div role="gridcell" className="row-span-2 grid place-items-center sm:row-span-1">
        <Checkbox
          checked={p.selected}
          tabIndex={-1}
          label={`Select ${name.text}`}
          onChange={p.onCheckboxChange}
        />
      </div>
      <div role="gridcell" className="flex min-w-0 items-center">
        <SenderAvatar name={g.senderName} address={g.sender} domain={g.domain} size={22} />
        <span className="ml-[9px] min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-emphasis ${name.unknown ? "text-ink-3" : "text-ink"}`}>
              {name.text}
            </span>
            {g.ceilingApplied ? <VerdictTag kind="protected" size="sm" /> : null}
          </span>
          <span className="block truncate text-small text-ink-3">
            {p.accountEmail ? `${p.accountEmail} · ` : ""}
            {second}
          </span>
        </span>
      </div>
      <div role="gridcell" className="col-start-2 row-start-2 justify-self-start sm:col-auto sm:row-auto">
        <VerdictTag kind={g.action} />
      </div>
      <div role="gridcell" className="col-start-3 row-start-2 w-[108px] sm:col-auto sm:row-auto">
        <ConfidenceLabel
          value={g.confidence.avg}
          verdict={g.action}
          tau={p.tau}
          variant="cell"
          modelUnavailable={unavailable}
        />
      </div>
      <div
        role="gridcell"
        className="col-start-3 row-start-1 flex justify-end font-emphasis text-ink-2 sm:col-auto sm:row-auto"
      >
        {p.busy ? <Spinner /> : formatCount(g.count)}
      </div>
    </div>
  );
}
