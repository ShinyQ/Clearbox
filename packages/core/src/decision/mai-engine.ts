import type { FetchLike } from "../http/fetch.ts";
import { parseRetryAfter } from "../http/fetch.ts";
import { DECISION_TIMEOUT_MS } from "../model/constants.ts";
import { DecisionError, type DecisionErrorKind } from "../model/errors.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";
import { buildDecisionRequest } from "./questions.ts";
import { normalizeDecisionResponse } from "./response.ts";

export interface MaiEngineConfig {
  /** AZURE_DECISION_ENDPOINT (account root, e.g. https://<foundry-account>.services.ai.azure.com). */
  endpoint: string;
  /** AZURE_DECISION_DEPLOYMENT. */
  deployment: string;
  /** AZURE_DECISION_KEY. */
  apiKey: string;
  fetch: FetchLike;
  /** Default DECISION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clock for latency and Retry-After dates. Default Date.now. */
  now?: () => number;
}

export const DECISION_PATH = "/providers/microsoft/v1/systemone";

/** HTTP status to error kind. Unlisted 4xx are bad_request (not retryable); unlisted 5xx are server (retryable). */
export function decisionErrorKindForStatus(status: number): DecisionErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "deployment_not_found";
  if (status === 408) return "server";
  if (status === 413) return "too_large";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** POST `${endpoint}/providers/microsoft/v1/systemone`, headers `api-key`, `content-type: application/json`. No api-version. */
export class MaiDecisionEngine implements DecisionEngine {
  readonly name = "mai" as const;
  readonly #config: MaiEngineConfig;
  readonly #url: string;

  constructor(config: MaiEngineConfig) {
    this.#config = config;
    this.#url = `${config.endpoint.replace(/\/+$/, "")}${DECISION_PATH}`;
  }

  async decide(input: DecisionInput): Promise<DecisionResult> {
    const { deployment, apiKey, fetch } = this.#config;
    const now = this.#config.now ?? Date.now;
    const timeoutMs = this.#config.timeoutMs ?? DECISION_TIMEOUT_MS;
    const body = JSON.stringify(buildDecisionRequest(input.state, deployment, input.seed));
    const started = now();

    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = isTimeout(error) ? "timeout" : "network";
      throw new DecisionError({ kind, cause: error });
    }

    const requestId = response.headers.get("apim-request-id");
    if (!response.ok) {
      await response.body?.cancel();
      throw new DecisionError({
        kind: decisionErrorKindForStatus(response.status),
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers, now()),
        requestId,
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      // A JSON SyntaxError message embeds a prefix of the body, so only a timeout keeps its cause.
      if (isTimeout(error)) {
        throw new DecisionError({ kind: "timeout", status: response.status, requestId, cause: error });
      }
      throw new DecisionError({ kind: "invalid_response", status: response.status, requestId });
    }
    return normalizeDecisionResponse(json, { deployment, requestId, latencyMs: now() - started });
  }
}
