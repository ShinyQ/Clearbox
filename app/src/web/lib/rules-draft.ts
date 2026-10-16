import type { Policy } from "@clearbox/core";
import { z } from "zod";
import { PatchSenderBodySchema } from "../../shared/api.ts";
import type { ChipValidation } from "../components/ui/ChipInput.tsx";

export type ListKey = "allowlist" | "denylist";

const SENDER_ERROR = "Use name@domain.com or @domain.com.";
const WORD_ERROR = "Use 2 to 40 characters.";
const RecordWordSchema = z.string().trim().toLowerCase().min(2).max(40);

export const MOVED_NOTE: Record<ListKey, string> = {
  allowlist: "Moved from Always OK to trash",
  denylist: "Moved from Always keep",
};

export const MIN_AGE_OPTIONS = [
  { value: "0", label: "Off" },
  ...[1, 2, 3, 5, 7, 14, 30].map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` })),
] as const satisfies readonly { value: string; label: string }[];

const other = (list: ListKey): ListKey => (list === "allowlist" ? "denylist" : "allowlist");

/** Adding to one list removes the entry from the other (UI spec 5.6, contracts 7.11). */
export function addEntry(
  policy: Policy,
  list: ListKey,
  value: string,
): { policy: Policy; movedFrom: ListKey | null } {
  const o = other(list);
  const moved = policy[o].includes(value);
  return {
    policy: { ...policy, [list]: [...policy[list], value], [o]: policy[o].filter((v) => v !== value) },
    movedFrom: moved ? o : null,
  };
}

export function removeEntry(policy: Policy, list: ListKey, value: string): Policy {
  return { ...policy, [list]: policy[list].filter((v) => v !== value) };
}

export const policiesEqual = (a: Policy, b: Policy): boolean => JSON.stringify(a) === JSON.stringify(b);

export function validateSenderEntry(raw: string): ChipValidation {
  const r = PatchSenderBodySchema.shape.entry.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: SENDER_ERROR };
}

export function validateRecordWord(raw: string): ChipValidation {
  const r = RecordWordSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: WORD_ERROR };
}

const POLICY_KEYS = [
  "allowlist",
  "denylist",
  "minAgeDays",
  "storeSnippets",
  "labelSubjects",
  "recordPatterns",
] as const;

/** Maps validation_failed details ({ path, message }[]) to one message per field. */
export function fieldErrors(details: unknown): Partial<Record<keyof Policy, string>> {
  if (!Array.isArray(details)) return {};
  const out: Partial<Record<keyof Policy, string>> = {};
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    const head = typeof d.path === "string" ? d.path.split(".")[0] : undefined;
    const key = POLICY_KEYS.find((k) => k === head);
    if (!key || out[key]) continue;
    out[key] =
      key === "allowlist" || key === "denylist"
        ? SENDER_ERROR
        : key === "recordPatterns"
          ? WORD_ERROR
          : String(d.message ?? "");
  }
  return out;
}
