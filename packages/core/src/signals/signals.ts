import type { AuthVerdict, MailCategory, MailMessage, OwnerPosition } from "../model/mail.ts";
import type { PriorCounts } from "../priors/priors.ts";
import { parseAddress, registrableDomain } from "../text/address.ts";
import {
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "../text/headers.ts";

export interface SenderHistory {
  /** Messages from this sender already stored, plus earlier messages from the same sender on the current page (the caller accumulates). */
  seenCount: number;
  readCount: number;
  isCorrespondent: boolean;
  senderPrior: PriorCounts | null;
  domainPrior: PriorCounts | null;
}

export interface SignalContext {
  now: number;
  /** Lowercased primary address + aliases. */
  ownerAddresses: readonly string[];
  /** Thread ids (Gmail) / conversation ids (Graph) the owner has sent in. */
  repliedThreadIds: ReadonlySet<string>;
}

export interface Signals {
  /** "" when unknown. */
  senderAddress: string;
  /** Registrable domain, "" when unknown. */
  senderDomain: string;
  senderName: string | null;
  /** Address parsed. */
  senderKnown: boolean;
  ownerReplied: boolean;
  isCorrespondent: boolean;
  /** Includes earlier messages on the same page. */
  senderSeenCount: number;
  /** readCount / seenCount, null when seenCount = 0. */
  senderOpenRate: number | null;
  /** senderPrior deletes / (deletes + keeps), null when no decisions. */
  ownerDeleteRate: number | null;
  /** senderPrior deletes + keeps. */
  ownerDecisions: number;
  hasListUnsubscribe: boolean;
  /** List-Unsubscribe-Post === "List-Unsubscribe=One-Click" and an https URI. */
  oneClickUnsubscribe: boolean;
  hasListId: boolean;
  /** bulk | list | junk. */
  precedenceBulk: boolean;
  /** Any value except "no". */
  autoSubmitted: boolean;
  /** Registrable domain of Return-Path, null for "<>" or missing. */
  espDomain: string | null;
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
  category: MailCategory | null;
  starred: boolean;
  providerImportant: boolean;
  /** floor((now - receivedAt) / 86_400_000), min 0. */
  ageDays: number;
  isRead: boolean;
  hasAttachments: boolean;
  attachmentsApprox: boolean;
  threadDepth: number | null;
  /** "to" if an owner address (or a Delivered-To address) is in To, "cc" if in Cc, else "bcc_or_list". */
  ownerPosition: OwnerPosition;
}

const DAY_MS = 86_400_000;

function ownerPosition(msg: MailMessage, ownerAddresses: readonly string[]): OwnerPosition {
  const owners = new Set([...ownerAddresses, ...msg.deliveredTo].map((a) => a.toLowerCase()));
  if (msg.to.some((a) => owners.has(a.toLowerCase()))) return "to";
  if (msg.cc.some((a) => owners.has(a.toLowerCase()))) return "cc";
  return "bcc_or_list";
}

function espDomain(returnPath: string | null): string | null {
  if (returnPath === null) return null;
  const parsed = parseAddress(returnPath);
  if (parsed.address === null) return null;
  const domain = registrableDomain(parsed.address);
  return domain === "" ? null : domain;
}

export function extractSignals(msg: MailMessage, history: SenderHistory, ctx: SignalContext): Signals {
  const address = msg.from.address ?? "";
  const headers = msg.headers;
  const unsubscribe = parseListUnsubscribe(headers.listUnsubscribe);
  const oneClickPost =
    (headers.listUnsubscribePost ?? "").trim().toLowerCase() === "list-unsubscribe=one-click";
  const auth = parseAuthResults(headers.authenticationResults);
  const prior = history.senderPrior;
  const ownerDecisions = prior === null ? 0 : prior.deletes + prior.keeps;

  return {
    senderAddress: address,
    senderDomain: address === "" ? "" : registrableDomain(address),
    senderName: msg.from.name,
    senderKnown: msg.from.address !== null,
    ownerReplied: msg.threadId !== null && ctx.repliedThreadIds.has(msg.threadId),
    isCorrespondent: history.isCorrespondent,
    senderSeenCount: history.seenCount,
    senderOpenRate: history.seenCount > 0 ? history.readCount / history.seenCount : null,
    ownerDeleteRate: prior !== null && ownerDecisions > 0 ? prior.deletes / ownerDecisions : null,
    ownerDecisions,
    hasListUnsubscribe: unsubscribe.https.length + unsubscribe.mailto.length > 0,
    oneClickUnsubscribe: oneClickPost && unsubscribe.https.length > 0,
    hasListId: (headers.listId ?? "").trim() !== "",
    precedenceBulk: isBulkPrecedence(headers.precedence),
    autoSubmitted: isAutoSubmitted(headers.autoSubmitted),
    espDomain: espDomain(headers.returnPath),
    auth: { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc },
    category: msg.category,
    starred: msg.starred,
    providerImportant: msg.providerImportant,
    ageDays: Math.max(0, Math.floor((ctx.now - msg.receivedAt) / DAY_MS)),
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    attachmentsApprox: msg.attachmentsApprox,
    threadDepth: msg.threadDepth,
    ownerPosition: ownerPosition(msg, ctx.ownerAddresses),
  };
}
