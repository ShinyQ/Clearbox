import {
  DEFAULT_POLICY,
  DELETE_MARGIN,
  DecisionError,
  MIN_CONFIDENCE,
  buildDecisionQuestions,
  buildDecisionState,
  decisionSeed,
  evaluateGuardrails,
  extractSignals,
  fnv1a32,
  fuse,
  mapWithConcurrency,
  selectPrior,
  type ActionKind,
  type Ceiling,
  type DecisionEngine,
  type DecisionInput,
  type DecisionResult,
  type DecisionState,
  type GuardrailResult,
  type Prior,
  type Signals,
  type SuggestedAction,
  type Thresholds,
} from "@clearbox/core";
import {
  OWNER_ADDRESS,
  threadIdFor,
  toMailMessage,
  type EvalFixture,
  type FixtureCategory,
} from "./fixtures.ts";
import { argmaxAction } from "./metrics.ts";

/** Synthetic account id used only to derive option-order seeds. */
export const EVAL_ACCOUNT_ID = "acc_00000000000000e1";
export const MAX_ATTEMPTS = 3;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class EvalAbortError extends Error {
  override name = "EvalAbortError";
}

export interface PreparedFixture {
  fixture: EvalFixture;
  signals: Signals;
  guard: GuardrailResult;
  prior: Prior;
  state: DecisionState;
  seed: number;
  shuffleSeed: number;
}

export function optionOrder(seed: number): string {
  return Object.keys(buildDecisionQuestions(seed).action.criteria).join(",");
}

/** First seed derived from the id whose action option order differs from the baseline order. */
export function alternateSeed(id: string, baseSeed: number): number {
  const baseline = optionOrder(baseSeed);
  const first = fnv1a32(`${id}:shuffle:1`);
  for (let k = 1; k <= 32; k++) {
    const candidate = fnv1a32(`${id}:shuffle:${k}`);
    if (optionOrder(candidate) !== baseline) return candidate;
  }
  return first;
}

/** Runs the same deterministic steps as a tick, without priors or past decisions. */
export function prepareFixture(fixture: EvalFixture, now: number): PreparedFixture {
  const msg = toMailMessage(fixture, now);
  const input = fixture.input;
  const signals =
    input.kind === "signals"
      ? input.signals
      : extractSignals(
          msg,
          { ...fixture.history, senderPrior: null, domainPrior: null },
          {
            now,
            ownerAddresses: [OWNER_ADDRESS],
            repliedThreadIds: new Set(input.ownerReplied ? [threadIdFor(fixture)] : []),
          },
        );
  const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, DEFAULT_POLICY);
  const prior = selectPrior(null, null, signals.senderAddress, signals.senderDomain);
  const state = buildDecisionState({ msg, signals, pastDecisions: [] });
  const seed = decisionSeed(EVAL_ACCOUNT_ID, fixture.id);
  return { fixture, signals, guard, prior, state, seed, shuffleSeed: alternateSeed(fixture.id, seed) };
}

/** Spaces call starts at least 60000 / rpm ms apart, across concurrent workers. */
export function createPacer(rpm: number, clock: Clock): () => Promise<void> {
  const interval = 60_000 / rpm;
  let next = 0;
  return async () => {
    const now = clock.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    if (slot > now) await clock.sleep(slot - now);
  };
}

/** Eval-only retries for transient errors; configuration errors abort the whole run. */
export async function decideWithRetry(
  engine: DecisionEngine,
  input: DecisionInput,
  pace: () => Promise<void>,
  clock: Clock,
): Promise<DecisionResult> {
  for (let attempt = 1; ; attempt++) {
    await pace();
    try {
      return await engine.decide(input);
    } catch (error) {
      if (error instanceof DecisionError && error.scope === "config") {
        throw new EvalAbortError(
          `Decision-1 configuration error (${error.kind}, HTTP ${error.status ?? "n/a"}). Check the AZURE_DECISION_* variables.`,
        );
      }
      if (!(error instanceof DecisionError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      await clock.sleep(error.retryAfterMs ?? 2_000 * attempt);
    }
  }
}

export interface EvalRow {
  id: string;
  source: EvalFixture["source"];
  category: FixtureCategory;
  label: ActionKind;
  ceiling: Ceiling;
  /** DecisionError kind, "unknown", or null on success. */
  error: string | null;
  modelAction: SuggestedAction | null;
  modelDelete: number | null;
  /** Fused suggestion; "unsure" when the model failed, as in production. */
  suggestion: SuggestedAction;
  confidence: number;
  fusedDelete: number | null;
  margin: number | null;
  shuffledModelAction: SuggestedAction | null;
  shuffledModelDelete: number | null;
  shuffledSuggestion: SuggestedAction | null;
  latencyMs: number[];
  inputTokens: number[];
  responseModel: string | null;
}

export interface EvalDeps {
  engine: DecisionEngine;
  clock: Clock;
  /** Wall-clock epoch ms used to compute message ages. */
  now: number;
  tauDelete: number;
  concurrency: number;
  rpm: number;
  shuffle: boolean;
  onProgress?: (done: number, total: number) => void;
}

function errorKind(error: unknown): string {
  if (error instanceof EvalAbortError) throw error;
  return error instanceof DecisionError ? error.kind : "unknown";
}

export async function evaluateFixture(
  prepared: PreparedFixture,
  deps: EvalDeps,
  pace: () => Promise<void>,
): Promise<EvalRow> {
  const { fixture, signals, guard, prior, state } = prepared;
  const thresholds: Thresholds = {
    tauDelete: deps.tauDelete,
    deleteMargin: DELETE_MARGIN,
    minConfidence: MIN_CONFIDENCE,
  };
  const latencyMs: number[] = [];
  const inputTokens: number[] = [];
  const record = (r: DecisionResult): void => {
    latencyMs.push(r.latencyMs);
    inputTokens.push(r.inputTokens);
  };

  let model: DecisionResult | null = null;
  let error: string | null = null;
  try {
    model = await decideWithRetry(
      deps.engine,
      { key: fixture.id, state, seed: prepared.seed },
      pace,
      deps.clock,
    );
    record(model);
  } catch (e) {
    error = errorKind(e);
  }
  const suggestion = fuse({ model, prior, guard, signals, thresholds });

  let shuffled: DecisionResult | null = null;
  if (deps.shuffle && model !== null) {
    try {
      shuffled = await decideWithRetry(
        deps.engine,
        { key: `${fixture.id}#shuffle`, state, seed: prepared.shuffleSeed },
        pace,
        deps.clock,
      );
      record(shuffled);
    } catch (e) {
      errorKind(e);
    }
  }

  return {
    id: fixture.id,
    source: fixture.source,
    category: fixture.category,
    label: fixture.label,
    ceiling: guard.ceiling,
    error,
    modelAction: model === null ? null : argmaxAction(model.action),
    modelDelete: model?.action.delete ?? null,
    suggestion: suggestion.action,
    confidence: suggestion.confidence,
    fusedDelete: suggestion.distribution?.delete ?? null,
    margin: suggestion.margin,
    shuffledModelAction: shuffled === null ? null : argmaxAction(shuffled.action),
    shuffledModelDelete: shuffled?.action.delete ?? null,
    shuffledSuggestion:
      shuffled === null ? null : fuse({ model: shuffled, prior, guard, signals, thresholds }).action,
    latencyMs,
    inputTokens,
    responseModel: model?.responseModel ?? null,
  };
}

export async function runEval(fixtures: readonly EvalFixture[], deps: EvalDeps): Promise<EvalRow[]> {
  const prepared = fixtures.map((f) => prepareFixture(f, deps.now));
  const pace = createPacer(deps.rpm, deps.clock);
  let done = 0;
  return mapWithConcurrency(prepared, deps.concurrency, async (p) => {
    const row = await evaluateFixture(p, deps, pace);
    done++;
    deps.onProgress?.(done, prepared.length);
    return row;
  });
}
