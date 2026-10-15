import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { DecisionInput } from "../../src/decision/engine.ts";
import { MaiDecisionEngine, decisionErrorKindForStatus } from "../../src/decision/mai-engine.ts";
import { buildDecisionQuestions } from "../../src/decision/questions.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError, type DecisionErrorKind } from "../../src/model/errors.ts";
import errorNotFound from "../fixtures/decision/error-deployment-not-found.json" with { type: "json" };
import errorUnprocessable from "../fixtures/decision/error-unprocessable.json" with { type: "json" };
import { makeMailMessage, makeSignals } from "../fixtures/builders.ts";
import { DecisionMockState, decisionHandlers, makeDecisionResponseBody } from "../msw/decision.ts";
import { server } from "../setup/msw.ts";

const ENDPOINT = "https://decision.example.test";

function input(seed = 42): DecisionInput {
  return {
    key: "msg-1",
    seed,
    state: buildDecisionState({ msg: makeMailMessage(), signals: makeSignals(), pastDecisions: [] }),
  };
}

function engine(
  overrides: Partial<ConstructorParameters<typeof MaiDecisionEngine>[0]> = {},
): MaiDecisionEngine {
  let t = 1_000;
  return new MaiDecisionEngine({
    endpoint: ENDPOINT,
    deployment: "decision-1",
    apiKey: "test-key",
    fetch: (i, init) => fetch(i, init),
    now: () => (t += 25),
    ...overrides,
  });
}

async function decideError(e: MaiDecisionEngine): Promise<DecisionError> {
  try {
    await e.decide(input());
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionError);
    return error as DecisionError;
  }
  throw new Error("expected decide() to throw");
}

let mock: DecisionMockState;

beforeEach(() => {
  mock = new DecisionMockState({ endpoint: ENDPOINT });
  server.use(...decisionHandlers(mock));
});

describe("MaiDecisionEngine", () => {
  it("posts exactly { model, state, questions } with api-key and returns a DecisionResult", async () => {
    const result = await engine().decide(input(42));
    expect(mock.requests).toHaveLength(1);
    const sent = mock.requests[0];
    expect(Object.keys(sent ?? {})).toEqual(["model", "state", "questions"]);
    expect(sent?.model).toBe("decision-1");
    expect(sent?.questions).toEqual(buildDecisionQuestions(42));
    expect(result.action.delete).toBeCloseTo(0.95, 9);
    expect(result.modelVersion).toBe("decision-1/microsoft-decision-1");
    expect(result.requestId).toBe("apim-0001");
    expect(result.latencyMs).toBe(25);
    expect(result.inputTokens).toBe(520);
  });

  it("strips a trailing slash from the endpoint", async () => {
    await engine({ endpoint: `${ENDPOINT}/` }).decide(input());
    expect(mock.requests).toHaveLength(1);
  });

  it("sends the same option order for the same seed (retries reproduce it)", async () => {
    const e = engine();
    await e.decide(input(7));
    await e.decide(input(7));
    const [a, b] = mock.requests;
    expect(Object.keys(a?.questions.action.criteria ?? {})).toEqual(
      Object.keys(b?.questions.action.criteria ?? {}),
    );
  });

  it("maps a wrong key to auth (config scope, not retryable)", async () => {
    const error = await decideError(engine({ apiKey: "wrong" }));
    expect([error.kind, error.status, error.scope, error.retryable]).toEqual(["auth", 401, "config", false]);
  });

  it("maps an unknown deployment to deployment_not_found", async () => {
    const error = await decideError(engine({ deployment: "decision-x" }));
    expect([error.kind, error.status, error.scope]).toEqual(["deployment_not_found", 404, "config"]);
  });

  const statusCases: [number, DecisionErrorKind, boolean, "config" | "item"][] = [
    [400, "bad_request", false, "item"],
    [401, "auth", false, "config"],
    [403, "auth", false, "config"],
    [404, "deployment_not_found", false, "config"],
    [408, "server", true, "item"],
    [413, "too_large", false, "item"],
    [422, "unprocessable", false, "item"],
    [429, "rate_limited", true, "item"],
    [500, "server", true, "item"],
    [502, "server", true, "item"],
    [503, "server", true, "item"],
    [504, "server", true, "item"],
  ];

  it.each(statusCases)("HTTP %i -> %s (retryable %s, scope %s)", async (status, kind, retryable, scope) => {
    mock.failNext({ status, body: status === 422 ? errorUnprocessable : errorNotFound });
    const error = await decideError(engine());
    expect([error.kind, error.status, error.retryable, error.scope]).toEqual([
      kind,
      status,
      retryable,
      scope,
    ]);
    expect(error.requestId).toBe("apim-0001");
    expect(error.message).not.toContain("TypeSafe");
  });

  it("honors retry-after-ms, then retry-after", async () => {
    mock.failNext({ status: 429, headers: { "retry-after-ms": "1500" } });
    expect((await decideError(engine())).retryAfterMs).toBe(1500);
    mock.failNext({ status: 429, headers: { "retry-after": "7" } });
    expect((await decideError(engine())).retryAfterMs).toBe(7000);
    mock.failNext({ status: 503 });
    expect((await decideError(engine())).retryAfterMs).toBeNull();
  });

  it("maps an invalid body to invalid_response", async () => {
    mock.respond = () => ({ model: "microsoft-decision-1", answers: {} });
    const error = await decideError(engine());
    expect([error.kind, error.retryable, error.requestId]).toEqual(["invalid_response", false, "apim-0001"]);
  });

  it("maps non-JSON success bodies to invalid_response", async () => {
    server.use(http.post(`${ENDPOINT}/providers/microsoft/v1/systemone`, () => new HttpResponse("not json")));
    expect((await decideError(engine())).kind).toBe("invalid_response");
  });

  it("maps a refusal answer to invalid_response", async () => {
    mock.respond = () => {
      const body = makeDecisionResponseBody() as { answers: Record<string, unknown> };
      body.answers.action = { type: "refusal" };
      return body;
    };
    expect((await decideError(engine())).kind).toBe("invalid_response");
  });

  it("maps a thrown fetch to network (retryable)", async () => {
    const error = await decideError(engine({ fetch: () => Promise.reject(new TypeError("fetch failed")) }));
    expect([error.kind, error.retryable, error.status]).toEqual(["network", true, null]);
  });

  it("maps a timeout to timeout (retryable)", async () => {
    server.use(
      http.post(`${ENDPOINT}/providers/microsoft/v1/systemone`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(makeDecisionResponseBody());
      }),
    );
    const error = await decideError(engine({ timeoutMs: 20 }));
    expect([error.kind, error.retryable]).toEqual(["timeout", true]);
  });

  it("never retries internally", async () => {
    let calls = 0;
    const counting = (i: Request | string | URL, init?: RequestInit) => {
      calls++;
      return fetch(i, init);
    };
    mock.failNext({ status: 503, times: 5 });
    await decideError(engine({ fetch: counting }));
    expect(calls).toBe(1);
  });
});

describe("decisionErrorKindForStatus", () => {
  it("maps unlisted 4xx to bad_request and unlisted 5xx to server", () => {
    expect(decisionErrorKindForStatus(405)).toBe("bad_request");
    expect(decisionErrorKindForStatus(409)).toBe("bad_request");
    expect(decisionErrorKindForStatus(507)).toBe("server");
  });
});
