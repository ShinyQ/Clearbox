import type { ApiReason } from "../../shared/api.ts";
import { formatCount } from "./format.ts";
import type { Band, Verdict } from "./view-types.ts";

export const VERY_SURE_MIN = 0.95;
export const LIKELY_MIN = 0.7;

/** Band for a confidence value. tau always comes from the API. Check (unsure) verdicts are always "unsure". */
export function bandFor(confidence: number, tau: number, verdict: Verdict): Band {
  if (verdict === "unsure") return "unsure";
  if (confidence < LIKELY_MIN) return "unsure";
  if (confidence < tau) return "likely";
  if (confidence < VERY_SURE_MIN) return "sure";
  return "very_sure";
}

/** Floor, never round, so 0.949 shows "94%" and stays consistent with the band. Epsilon guards float drift. */
export function toPercent(confidence: number): number {
  // Epsilon keeps values like 0.29 (0.28999999) from flooring one point low.
  return Math.floor(confidence * 100 + 1e-9);
}

/** True when this verdict and band are executed by Clean up. Keep is never in Clean up. */
export function inCleanup(verdict: Verdict, band: Band): boolean {
  return (verdict === "delete" || verdict === "archive") && (band === "sure" || band === "very_sure");
}

export const BAND_FILL: Record<Band, string> = {
  very_sure: "bg-band-very-sure",
  sure: "bg-band-sure",
  likely: "bg-band-likely",
  unsure: "bg-band-unsure",
};

export const BAND_INK: Record<Band, string> = {
  very_sure: "text-band-very-sure-ink",
  sure: "text-band-sure-ink",
  likely: "text-band-likely-ink",
  unsure: "text-band-unsure-ink",
};

export interface ScaleBand {
  band: Band;
  label: string;
  range: string;
  membership: string;
}

export function scaleBands(tau: number): ScaleBand[] {
  const t = toPercent(tau);
  const sure: ScaleBand =
    tau >= VERY_SURE_MIN
      ? { band: "sure", label: "Sure", range: "None right now", membership: "Threshold is above 95%" }
      : { band: "sure", label: "Sure", range: `${t} to 94%`, membership: "In Clean up" };
  const veryLow = Math.max(t, 95);
  return [
    { band: "very_sure", label: "Very sure", range: `${veryLow} to 100%`, membership: "In Clean up" },
    sure,
    { band: "likely", label: "Likely", range: `70 to ${t - 1}%`, membership: "Left for you" },
    { band: "unsure", label: "Unsure", range: "Below 70%", membership: "Left for you" },
  ];
}

/** Detail panel membership line (UI spec 4.14). */
export function membershipLine(
  verdict: Verdict,
  conf: { min: number; max: number },
  tau: number,
  count: number,
): string {
  if (verdict === "keep") return "Keep suggestions are not part of Clean up.";
  if (verdict === "unsure") return "Clearbox needs your call on this group.";
  const p = toPercent(tau);
  if (conf.min >= tau)
    return count === 1 ? "The 1 email is in Clean up." : `All ${formatCount(count)} are in Clean up.`;
  if (conf.max >= tau) return `Emails below ${p}% stay here for you after Clean up.`;
  return `Below ${p}%, so Clean up leaves this group for you.`;
}

/** Short phrase for row accessible names (decision W17). */
export function membershipPhrase(verdict: Verdict, band: Band): string {
  if (inCleanup(verdict, band)) return "in Clean up";
  return verdict === "keep" ? "not in Clean up" : "left for you";
}

export function isModelUnavailable(group: { action: Verdict; topReasons: readonly ApiReason[] }): boolean {
  return group.action === "unsure" && group.topReasons[0]?.code === "model_unavailable";
}
