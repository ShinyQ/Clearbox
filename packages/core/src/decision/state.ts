import type { ActionKind } from "../model/actions.ts";
import {
  DECISION_SNIPPET_MAX_CHARS,
  DECISION_STATE_MAX_CHARS,
  DECISION_SUBJECT_MAX_CHARS,
  PAST_DECISION_SUBJECT_MAX_CHARS,
  PAST_DECISIONS_MAX,
} from "../model/constants.ts";
import type { AuthVerdict, MailCategory, MailMessage, OwnerPosition } from "../model/mail.ts";
import type { Signals } from "../signals/signals.ts";
import { truncateChars } from "../text/truncate.ts";

export interface PastDecision {
  domain: string;
  /** Truncated to 60 chars, "" when labels have no subject. */
  subject: string;
  owner_action: ActionKind;
}

/** Exactly the JSON object sent as `state`. Compact JSON, no indentation. */
export interface DecisionState {
  email: {
    /** Sender address ("unknown" when not parseable). */
    from: string;
    domain: string;
    /** <= DECISION_SUBJECT_MAX_CHARS. */
    subject: string;
    /** <= DECISION_SNIPPET_MAX_CHARS. */
    snippet: string;
    age_days: number;
    signals: {
      has_list_unsubscribe: boolean;
      precedence_bulk: boolean;
      auto_submitted: boolean;
      category: MailCategory | null;
      is_read: boolean;
      has_attachments: boolean;
      owner_position: OwnerPosition;
      thread_depth: number | null;
      provider_important: boolean;
      auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    };
  };
  sender_history: {
    messages_seen: number;
    /** Rounded to 2 decimals. */
    open_rate: number | null;
    /** Rounded to 2 decimals. */
    owner_delete_rate: number | null;
    owner_decisions: number;
    is_correspondent: boolean;
  };
  /** <= 5: same sender first, then same domain, newest first. */
  similar_past_decisions: PastDecision[];
}

export interface BuildStateInput {
  msg: MailMessage;
  signals: Signals;
  pastDecisions: PastDecision[];
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function stateLength(state: DecisionState): number {
  return JSON.stringify(state).length;
}

/**
 * Token budget: JSON.stringify(state).length <= DECISION_STATE_MAX_CHARS (1,750 chars = 500 tokens at 3.5 chars/token).
 * Shrink order until it fits: drop similar_past_decisions from the end one by one,
 * then snippet to 150 chars, then snippet to "", then subject to 60 chars, then subject to "",
 * then (sender-controlled fields) domain to 64 chars, from to 64 chars, domain to "", from to "".
 */
export function buildDecisionState(input: BuildStateInput): DecisionState {
  const { msg, signals } = input;
  const state: DecisionState = {
    email: {
      from: signals.senderAddress === "" ? "unknown" : signals.senderAddress,
      domain: signals.senderDomain,
      subject: truncateChars(msg.subject, DECISION_SUBJECT_MAX_CHARS),
      snippet: truncateChars(msg.snippet, DECISION_SNIPPET_MAX_CHARS),
      age_days: signals.ageDays,
      signals: {
        has_list_unsubscribe: signals.hasListUnsubscribe,
        precedence_bulk: signals.precedenceBulk,
        auto_submitted: signals.autoSubmitted,
        category: signals.category,
        is_read: signals.isRead,
        has_attachments: signals.hasAttachments,
        owner_position: signals.ownerPosition,
        thread_depth: signals.threadDepth,
        provider_important: signals.providerImportant,
        auth: { ...signals.auth },
      },
    },
    sender_history: {
      messages_seen: signals.senderSeenCount,
      open_rate: round2(signals.senderOpenRate),
      owner_delete_rate: round2(signals.ownerDeleteRate),
      owner_decisions: signals.ownerDecisions,
      is_correspondent: signals.isCorrespondent,
    },
    similar_past_decisions: input.pastDecisions.slice(0, PAST_DECISIONS_MAX).map((d) => ({
      domain: d.domain,
      subject: truncateChars(d.subject, PAST_DECISION_SUBJECT_MAX_CHARS),
      owner_action: d.owner_action,
    })),
  };

  while (stateLength(state) > DECISION_STATE_MAX_CHARS && state.similar_past_decisions.length > 0) {
    state.similar_past_decisions.pop();
  }
  const shrinkSteps: (() => void)[] = [
    () => (state.email.snippet = truncateChars(state.email.snippet, 150)),
    () => (state.email.snippet = ""),
    () => (state.email.subject = truncateChars(state.email.subject, 60)),
    () => (state.email.subject = ""),
    // Last resort: sender-controlled fields are unbounded, so cap them after everything else is gone.
    () => (state.email.domain = truncateChars(state.email.domain, 64)),
    () => (state.email.from = truncateChars(state.email.from, 64)),
    () => (state.email.domain = ""),
    () => (state.email.from = ""),
  ];
  for (const step of shrinkSteps) {
    if (stateLength(state) <= DECISION_STATE_MAX_CHARS) break;
    step();
  }
  return state;
}
