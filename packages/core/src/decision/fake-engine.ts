import type { ActionDistribution } from "../model/actions.ts";
import { DecisionError } from "../model/errors.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";

export interface FakeEngineOptions {
  /** Per-key canned results or errors; anything else uses the built-in rules. */
  overrides?: ReadonlyMap<string, DecisionResult | DecisionError>;
}

const RECORD_FOR_ACTION = /receipt|invoice|order|statement/i;
const RECORD_FLAG = /receipt|invoice|statement|order/i;
const EXPIRED_FLAG = /expire|ends tonight|last chance|one-time code/i;

function dist(d: number, a: number, k: number, u: number): ActionDistribution {
  return { delete: d, archive: a, keep: k, unsure: u };
}

/** Deterministic, rule-based engine for tests and local development (contracts 4.9.4). Never touches the network. */
export class FakeEngine implements DecisionEngine {
  readonly name = "fake" as const;
  readonly calls: DecisionInput[] = [];
  readonly #overrides: ReadonlyMap<string, DecisionResult | DecisionError>;

  constructor(options: FakeEngineOptions = {}) {
    this.#overrides = options.overrides ?? new Map();
  }

  decide(input: DecisionInput): Promise<DecisionResult> {
    this.calls.push(input);
    const override = this.#overrides.get(input.key);
    if (override instanceof DecisionError) return Promise.reject(override);
    if (override !== undefined) return Promise.resolve(override);
    return Promise.resolve(FakeEngine.rules(input));
  }

  private static rules(input: DecisionInput): DecisionResult {
    const { email, sender_history: history } = input.state;
    const subject = email.subject;
    const s = email.signals;

    let action: ActionDistribution;
    if (history.is_correspondent) action = dist(0.02, 0.08, 0.85, 0.05);
    else if (RECORD_FOR_ACTION.test(subject)) action = dist(0.05, 0.8, 0.1, 0.05);
    else if (s.has_list_unsubscribe && !s.is_read) action = dist(0.9, 0.04, 0.03, 0.03);
    else if (s.has_list_unsubscribe) action = dist(0.6, 0.2, 0.1, 0.1);
    else action = dist(0.15, 0.2, 0.3, 0.35);

    const isRecordSubject = RECORD_FLAG.test(subject);
    return {
      action,
      importance: history.is_correspondent ? 3 : isRecordSubject ? 1 : 0.5,
      flags: {
        isRecord: isRecordSubject ? 0.9 : 0.05,
        isExpired: EXPIRED_FLAG.test(subject) ? 0.9 : 0.1,
        isFromHuman: history.is_correspondent ? 0.9 : 0.05,
      },
      responseModel: "fake-1",
      modelVersion: "fake/fake-1",
      inputTokens: Math.ceil(JSON.stringify(input.state).length / 3.5) + 250,
      requestId: null,
      latencyMs: 0,
    };
  }
}
