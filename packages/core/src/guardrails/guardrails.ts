import { minCeiling, type Ceiling } from "../model/actions.ts";
import type { Reason } from "../model/reasons.ts";
import { matchesSenderList, matchRecordPattern, type Policy } from "../policy/policy.ts";
import type { Signals } from "../signals/signals.ts";

export interface GuardrailInput {
  signals: Signals;
  subject: string;
  snippet: string;
}

export interface GuardrailResult {
  ceiling: Ceiling;
  /** Reasons for every cap that lowered the ceiling below "delete", in rule order. */
  reasons: Reason[];
  allowlisted: boolean;
  denylisted: boolean;
}

export function evaluateGuardrails(input: GuardrailInput, policy: Policy): GuardrailResult {
  const { signals } = input;
  const allowlisted = matchesSenderList(signals.senderAddress, signals.senderDomain, policy.allowlist);
  const denylisted =
    !allowlisted && matchesSenderList(signals.senderAddress, signals.senderDomain, policy.denylist);

  let ceiling: Ceiling = "delete";
  const reasons: Reason[] = [];
  const cap = (to: Ceiling, reason: Reason): void => {
    ceiling = minCeiling(ceiling, to);
    reasons.push(reason);
  };

  if (signals.starred) cap("keep", { code: "guard_starred", params: {} });
  if (signals.ownerReplied) cap("keep", { code: "guard_replied", params: {} });
  if (allowlisted) cap("keep", { code: "guard_allowlist", params: {} });
  if (signals.ageDays < policy.minAgeDays) {
    cap("keep", { code: "guard_too_recent", params: { minAgeDays: policy.minAgeDays } });
  }
  if (!denylisted) {
    if (signals.isCorrespondent) cap("keep", { code: "guard_correspondent", params: {} });
    if (signals.hasAttachments) cap("archive", { code: "guard_attachment", params: {} });
    const pattern = matchRecordPattern(input.subject, input.snippet, policy.recordPatterns);
    if (pattern !== null) cap("archive", { code: "guard_record_pattern", params: { pattern } });
  }

  return { ceiling, reasons, allowlisted, denylisted };
}
