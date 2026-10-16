import { BAND_FILL, BAND_INK, bandFor, scaleBands, toPercent } from "../../lib/confidence.ts";
import { BAND_LABEL, type Verdict } from "../../lib/view-types.ts";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { ConfidenceMeter } from "./ConfidenceMeter.tsx";

export interface ConfidenceLabelProps {
  value: number;
  verdict: Verdict;
  tau: number;
  variant: "cell" | "inline" | "scale";
  modelUnavailable?: boolean | undefined;
}

export function ConfidenceScale({ tau }: { tau: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {scaleBands(tau).map((b) => (
        <div key={b.band} className="rounded-lg border border-line px-2.5 py-[9px] text-small">
          <div className="flex items-center gap-1.5">
            <i aria-hidden="true" className={`size-[9px] rounded-[3px] ${BAND_FILL[b.band]}`} />
            <span className="font-semibold text-ink">{b.label}</span>
          </div>
          <div className="text-ink-2">{b.range}</div>
          <div className="text-ink-3">{b.membership}</div>
        </div>
      ))}
    </div>
  );
}

export function ConfidenceLabel({
  value,
  verdict,
  tau,
  variant,
  modelUnavailable = false,
}: ConfidenceLabelProps) {
  if (variant === "scale") return <ConfidenceScale tau={tau} />;
  const band = modelUnavailable ? "unsure" : bandFor(value, tau, verdict);
  const pct = modelUnavailable ? "n/a" : `${toPercent(value)}%`;
  const word = BAND_LABEL[band];
  if (variant === "cell") {
    return (
      <span className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5">
        <span aria-hidden="true" className="text-small font-emphasis text-ink">
          {pct}
        </span>
        <span aria-hidden="true" className={`text-caption font-emphasis ${BAND_INK[band]}`}>
          {word}
        </span>
        <VisuallyHidden>
          {modelUnavailable ? "Confidence not available, Unsure" : `${toPercent(value)} percent, ${word}`}
        </VisuallyHidden>
        <span className="col-span-2">
          <ConfidenceMeter value={value} band={band} tau={tau} empty={modelUnavailable} />
        </span>
      </span>
    );
  }
  const hint = modelUnavailable
    ? "· model unavailable"
    : band === "likely" || band === "unsure"
      ? "· left for you"
      : null;
  return (
    <span className="inline-flex items-baseline gap-1.5 text-small">
      <span className="font-semibold text-ink">{pct}</span>
      <span className={`font-emphasis ${BAND_INK[band]}`}>{word}</span>
      {hint ? <span className="text-ink-3">{hint}</span> : null}
    </span>
  );
}
