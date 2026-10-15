import type { ActionKind } from "../model/actions.ts";
import { PRIOR_MIN_N } from "../model/constants.ts";

export interface PriorCounts {
  /** Owner chose delete. */
  deletes: number;
  /** Owner chose archive or keep (not delete). */
  keeps: number;
}

export interface Prior {
  source: "sender" | "domain" | "none";
  /** "user@example.com" or "@example.com". */
  key: string | null;
  /** 1 + deletes. */
  alpha: number;
  /** 1 + keeps. */
  beta: number;
  /** alpha + beta - 2. */
  n: number;
  /** alpha / (alpha + beta). */
  pDelete: number;
}

export const priorKeyForSender = (address: string): string => address;
export const priorKeyForDomain = (domain: string): string => `@${domain}`;

function toPrior(source: "sender" | "domain" | "none", key: string | null, counts: PriorCounts): Prior {
  const alpha = 1 + counts.deletes;
  const beta = 1 + counts.keeps;
  return { source, key, alpha, beta, n: alpha + beta - 2, pDelete: alpha / (alpha + beta) };
}

function total(counts: PriorCounts | null): number {
  return counts === null ? 0 : counts.deletes + counts.keeps;
}

/**
 * Sender prior when its n >= PRIOR_MIN_N, else domain prior when present (n > 0),
 * else sender prior (possibly n = 0), else "none" (alpha = beta = 1).
 */
export function selectPrior(
  sender: PriorCounts | null,
  domain: PriorCounts | null,
  address: string,
  domainName: string,
): Prior {
  if (sender !== null && total(sender) >= PRIOR_MIN_N) {
    return toPrior("sender", priorKeyForSender(address), sender);
  }
  if (domain !== null && total(domain) > 0) {
    return toPrior("domain", priorKeyForDomain(domainName), domain);
  }
  if (sender !== null) {
    return toPrior("sender", priorKeyForSender(address), sender);
  }
  return toPrior("none", null, { deletes: 0, keeps: 0 });
}

/** Delta to apply to both the sender key and the domain key for one owner action (undo passes the inverse). */
export function priorDelta(ownerAction: ActionKind, direction: 1 | -1): PriorCounts {
  return ownerAction === "delete" ? { deletes: direction, keeps: 0 } : { deletes: 0, keeps: direction };
}

/** Applies priorDelta to stored counts (null = no row yet); counts never drop below 0. */
export function applyOwnerAction(
  counts: PriorCounts | null,
  ownerAction: ActionKind,
  direction: 1 | -1,
): PriorCounts {
  const base = counts ?? { deletes: 0, keeps: 0 };
  const delta = priorDelta(ownerAction, direction);
  return {
    deletes: Math.max(0, base.deletes + delta.deletes),
    keeps: Math.max(0, base.keeps + delta.keeps),
  };
}
