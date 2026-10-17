import { LABEL_SUBJECT_MAX_CHARS, priorDelta } from "@clearbox/core";
import type { ActionKind, Ceiling, DecisionSegment, SuggestedAction } from "@clearbox/core";
import type { LabelInsert, LabelSource } from "../db/labels.ts";
import { addPriorDelta } from "../db/priors.ts";
import type { PriorDeltaMap } from "../db/priors.ts";

export interface DecidedItem {
  messageId: number;
  accountId: string;
  sender: string;
  senderDomain: string;
  subject: string | null;
  suggestedAction: SuggestedAction;
  ownerAction: ActionKind;
  pDelete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  /** contracts 12.10: copied to the label for per-segment calibration. */
  segment?: DecisionSegment | null;
  modelVersion: string | null;
  policyVersion: number;
}

/** Code-point safe truncation to LABEL_SUBJECT_MAX_CHARS; null when policy.labelSubjects is false. */
export function truncateSubject(subject: string | null, labelSubjects: boolean): string | null {
  if (!labelSubjects || subject === null) return null;
  return Array.from(subject).slice(0, LABEL_SUBJECT_MAX_CHARS).join("");
}

export function labelFor(
  item: DecidedItem,
  source: LabelSource,
  labelSubjects: boolean,
  now: number,
): LabelInsert {
  return {
    messageId: item.messageId,
    sender: item.sender,
    senderDomain: item.senderDomain,
    subjectTrunc: truncateSubject(item.subject, labelSubjects),
    suggestedAction: item.suggestedAction,
    ownerAction: item.ownerAction,
    source,
    pDelete: item.pDelete,
    margin: item.margin,
    ceiling: item.ceiling,
    segment: item.segment ?? null,
    modelVersion: item.modelVersion,
    policyVersion: item.policyVersion,
    now,
  };
}

export function decisionPriorDeltas(items: readonly DecidedItem[]): PriorDeltaMap {
  const map: PriorDeltaMap = new Map();
  for (const i of items)
    addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta(i.ownerAction, 1));
  return map;
}

export interface UndoneItem {
  accountId: string;
  sender: string;
  senderDomain: string;
  finalAction: ActionKind;
}

/** Contracts 7.8: priorDelta(original, -1) plus priorDelta("keep", +1). */
export function undoPriorDeltas(items: readonly UndoneItem[]): PriorDeltaMap {
  const map: PriorDeltaMap = new Map();
  for (const i of items) {
    addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta(i.finalAction, -1));
    addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta("keep", 1));
  }
  return map;
}
