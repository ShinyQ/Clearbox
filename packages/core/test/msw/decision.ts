import { http, HttpResponse } from "msw";
import type { DecisionRequestBody } from "../../src/decision/questions.ts";
import { DECISION_STATE_MAX_CHARS } from "../../src/model/constants.ts";

export interface DecisionFailSpec {
  /** Accepted for parity with other handler factories; the Decision-1 mock has one route. */
  method?: string;
  path?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** How many upcoming requests fail this way (default 1). */
  times?: number;
}

export interface DecisionMockOptions {
  endpoint?: string;
  deployment?: string;
  apiKey?: string;
}

const QUESTION_KEYS = ["action", "importance", "is_record", "is_expired", "is_from_human"] as const;

/** Synthetic response in the documented shape (research decision-1.md 4.3). */
export function makeDecisionResponseBody(
  probabilities: { delete: number; archive: number; keep: number; unsure: number } = {
    delete: 0.95,
    archive: 0.02,
    keep: 0.01,
    unsure: 0.02,
  },
): Record<string, unknown> {
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["unsure"])[0];
  return {
    model: "microsoft-decision-1",
    answers: {
      action: { type: "choice", choice, confidence: 0.9, probabilities },
      importance: {
        type: "score",
        score: 0.21,
        confidence: 0.7,
        legend: { "0": "Noise", "1": "Low", "2": "Moderate", "3": "High", "4": "Critical" },
        probabilities: { "0": 0.81, "1": 0.17, "2": 0.02, "3": 0, "4": 0 },
      },
      is_record: { type: "noul", noul: 0.03 },
      is_expired: { type: "noul", noul: 0.91 },
      is_from_human: { type: "noul", noul: 0.01 },
    },
    usage: { input_tokens: 520, output_tokens: 5 },
  };
}

/** In-memory state behind decisionHandlers: request log, failure injection and a replaceable responder. */
export class DecisionMockState {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly requests: DecisionRequestBody[] = [];
  respond: (body: DecisionRequestBody) => unknown = () => makeDecisionResponseBody();
  #failures: DecisionFailSpec[] = [];
  #counter = 0;

  constructor(options: DecisionMockOptions = {}) {
    this.endpoint = options.endpoint ?? "https://decision.example.test";
    this.deployment = options.deployment ?? "decision-1";
    this.apiKey = options.apiKey ?? "test-key";
  }

  failNext(spec: DecisionFailSpec): void {
    this.#failures.push({ ...spec, times: spec.times ?? 1 });
  }

  takeFailure(): DecisionFailSpec | null {
    const next = this.#failures[0];
    if (next === undefined) return null;
    const times = (next.times ?? 1) - 1;
    if (times <= 0) this.#failures.shift();
    else next.times = times;
    return next;
  }

  nextRequestId(): string {
    this.#counter += 1;
    return `apim-${String(this.#counter).padStart(4, "0")}`;
  }
}

function azureError(status: number, code: string, message: string, requestId: string): Response {
  return HttpResponse.json(
    { error: { code, message } },
    { status, headers: { "apim-request-id": requestId } },
  );
}

function validationProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "model,questions,state") return `unexpected top-level fields: ${keys.join(",")}`;
  const { questions, state } = body as { questions: unknown; state: unknown };
  if (typeof questions !== "object" || questions === null) return "questions must be an object";
  for (const key of QUESTION_KEYS) {
    if (!(key in questions)) return `missing question ${key}`;
  }
  if (JSON.stringify(state).length > DECISION_STATE_MAX_CHARS) return "state exceeds the token budget";
  return null;
}

/** MSW handlers for POST {endpoint}/providers/microsoft/v1/systemone. */
export function decisionHandlers(state: DecisionMockState) {
  return [
    http.post(`${state.endpoint}/providers/microsoft/v1/systemone`, async ({ request }) => {
      const requestId = state.nextRequestId();
      if (request.headers.get("api-key") !== state.apiKey) {
        return azureError(401, "Unauthorized", "Access denied due to invalid key.", requestId);
      }
      const body = (await request.json()) as unknown;
      const failure = state.takeFailure();
      if (failure !== null) {
        const headers = { "apim-request-id": requestId, ...failure.headers };
        return failure.body === undefined
          ? new HttpResponse(null, { status: failure.status, headers })
          : HttpResponse.json(failure.body, { status: failure.status, headers });
      }
      const problem = validationProblem(body);
      if (problem !== null) return azureError(400, "unrecognized_request_argument", problem, requestId);
      const typed = body as DecisionRequestBody;
      if (typed.model !== state.deployment) {
        return azureError(
          404,
          "DeploymentNotFound",
          `The API deployment ${typed.model} does not exist.`,
          requestId,
        );
      }
      state.requests.push(typed);
      return HttpResponse.json(state.respond(typed) as Record<string, unknown>, {
        headers: { "apim-request-id": requestId, "x-request-id": requestId },
      });
    }),
  ];
}
