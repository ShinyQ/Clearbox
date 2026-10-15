import { DecisionError } from "@clearbox/core";
import type { DecisionErrorKind } from "@clearbox/core";
import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";

export const DECISION_URL = "https://decision.example.test/providers/microsoft/v1/systemone";

const OK_BODY = {
  model: "microsoft-decision-1",
  answers: {
    action: {
      type: "choice",
      choice: "delete",
      probabilities: { delete: 0.9, archive: 0.04, keep: 0.03, unsure: 0.03 },
    },
    importance: { type: "score", score: 0.5 },
    is_record: { type: "noul", noul: 0.05 },
    is_expired: { type: "noul", noul: 0.1 },
    is_from_human: { type: "noul", noul: 0.05 },
  },
  usage: { input_tokens: 420, output_tokens: 5 },
};

export class DecisionMock {
  calls = 0;
  status = 200;

  handlers(): HttpHandler[] {
    return [
      http.post(DECISION_URL, () => {
        this.calls += 1;
        if (this.status !== 200) {
          return HttpResponse.json(
            { error: { code: "Injected", message: "injected" } },
            { status: this.status },
          );
        }
        return HttpResponse.json(OK_BODY, { headers: { "apim-request-id": `req-${this.calls}` } });
      }),
    ];
  }
}

export function decisionError(
  kind: DecisionErrorKind,
  status: number | null,
  retryable: boolean,
  scope: "config" | "item",
): DecisionError {
  return new DecisionError({ kind, status, retryable, scope, retryAfterMs: null, requestId: null });
}
