import { useState } from "react";
import { ConfidenceLabel, ConfidenceScale } from "../../components/review/ConfidenceLabel.tsx";
import { ConfirmBar } from "../../components/review/ConfirmBar.tsx";
import { SenderGroupRow } from "../../components/review/SenderGroupRow.tsx";
import { VerdictTag } from "../../components/review/VerdictTag.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { GalleryCard } from "./GalleryControls.tsx";
import { GALLERY_GROUPS } from "./sample-data.ts";

const noop = () => undefined;

export function TagsCard() {
  return (
    <GalleryCard title="Verdict tags (icon + word, never color alone)">
      {(["md", "sm"] as const).map((size) => (
        <div key={size} className="flex flex-wrap gap-1.5">
          {(["delete", "archive", "keep", "unsure", "protected"] as const).map((k) => (
            <VerdictTag key={k} kind={k} size={size} />
          ))}
        </div>
      ))}
    </GalleryCard>
  );
}

export function ScaleCard() {
  const [tau, setTau] = useState(0.86);
  return (
    <GalleryCard title="Confidence scale (tick = Clean up threshold, tuned nightly)">
      <label className="flex items-center gap-2 text-small text-ink-2">
        Threshold
        <input
          type="range"
          min={0.8}
          max={0.99}
          step={0.01}
          value={tau}
          onChange={(e) => setTau(Number(e.target.value))}
        />
        {`${Math.round(tau * 100)}%`}
      </label>
      <ConfidenceScale tau={tau} />
      <div className="flex flex-col gap-1.5">
        {[0.97, 0.89, 0.78, 0.54].map((v) => (
          <ConfidenceLabel key={v} value={v} verdict="delete" tau={tau} variant="inline" />
        ))}
      </div>
    </GalleryCard>
  );
}

export function RowsCard() {
  return (
    <GalleryCard title="Rows">
      <div role="grid" aria-label="Row states" className="overflow-clip rounded-lg border border-line">
        {GALLERY_GROUPS.map((r, i) => (
          <SenderGroupRow
            key={r.group.key}
            group={r.group}
            tau={0.86}
            rowIndex={i}
            active={r.active ?? false}
            selected={r.selected ?? false}
            busy={r.busy ?? false}
            exiting={false}
            focusable={i === 0}
            accountEmail={null}
            onClick={noop}
            onCheckboxChange={noop}
          />
        ))}
      </div>
    </GalleryCard>
  );
}

export function BarsCard() {
  const platform = usePlatform();
  const common = {
    mode: "cleanup" as const,
    platform,
    onConfirm: noop,
    onCancel: noop,
    onStop: noop,
    onRetry: noop,
  };
  return (
    <GalleryCard title="Confirm bar">
      <ConfirmBar
        {...common}
        phase="confirming"
        title="Clean up 1,284 emails in 371 sender groups?"
        detail="1,102 go to Trash and 182 to Archive. Nothing is permanently deleted. 41 groups below 86% stay here for you."
      />
      <ConfirmBar
        {...common}
        phase="running"
        title="Cleaning up… 812 of 1,284"
        detail=""
        processed={812}
        total={1284}
      />
      <ConfirmBar
        {...common}
        phase="partial"
        title="Clean up paused at today's free-tier limit. 1,180 emails were cleaned up."
        detail="The other 104 stay in Review. Actions work again after 07:00."
      />
      <ConfirmBar
        {...common}
        phase="running"
        title="Stopping after this step…"
        detail=""
        processed={812}
        total={1284}
        stopping
      />
      <ConfirmBar
        {...common}
        phase="partial"
        title="1,150 emails were cleaned up. 134 were skipped."
        detail="you@example.com needs to reconnect before its emails can be moved."
        extraAction={{ label: "Reconnect", onClick: noop }}
      />
    </GalleryCard>
  );
}
