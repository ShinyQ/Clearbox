import { describe, expect, it } from "vitest";
import {
  ClearboxError,
  CursorExpiredError,
  DECISION_ERROR_RULES,
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ScopeMissingError,
  SubrequestBudgetError,
  type DecisionErrorKind,
} from "../../src/model/errors.ts";

describe("ClearboxError", () => {
  it("carries code, message, name and cause", () => {
    const cause = new Error("root");
    const error = new ClearboxError("some_code", "Some message", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("some_code");
    expect(error.message).toBe("Some message");
    expect(error.name).toBe("ClearboxError");
    expect(error.cause).toBe(cause);
  });

  it("defaults the message to the code", () => {
    expect(new ClearboxError("x_code").message).toBe("x_code");
  });
});

describe("provider errors", () => {
  it("set code, name and fields", () => {
    const auth = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    expect(auth).toBeInstanceOf(ClearboxError);
    expect([auth.code, auth.name, auth.provider, auth.reason]).toEqual([
      "provider_auth",
      "ProviderAuthError",
      "gmail",
      "invalid_grant",
    ]);

    const config = new ProviderConfigError({ provider: "outlook", reason: "AADSTS7000222" });
    expect([config.code, config.reason]).toEqual(["provider_config", "AADSTS7000222"]);

    const rate = new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 30_000 });
    expect([rate.code, rate.retryAfterMs]).toEqual(["provider_rate_limited", 30_000]);

    const unavailable = new ProviderUnavailableError({ provider: "gmail" });
    expect([unavailable.code, unavailable.retryAfterMs]).toEqual(["provider_unavailable", null]);

    const cursor = new CursorExpiredError({ provider: "gmail", cursorKind: "incremental" });
    expect([cursor.code, cursor.cursorKind]).toEqual(["cursor_expired", "incremental"]);

    const response = new ProviderResponseError({ provider: "gmail", status: 418 });
    expect([response.code, response.status]).toEqual(["provider_response", 418]);

    const scope = new ScopeMissingError({ provider: "gmail", granted: ["openid"] });
    expect([scope.code, scope.granted]).toEqual(["scope_missing", ["openid"]]);

    const budget = new SubrequestBudgetError({ used: 45, limit: 45 });
    expect([budget.code, budget.used, budget.limit]).toEqual(["subrequest_budget", 45, 45]);
  });

  it("never puts user data in default messages", () => {
    const error = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    expect(error.message).toBe("gmail authorization failed (invalid_grant)");
  });
});

describe("DecisionError", () => {
  const expected: [DecisionErrorKind, boolean, "config" | "item"][] = [
    ["auth", false, "config"],
    ["deployment_not_found", false, "config"],
    ["bad_request", false, "item"],
    ["too_large", false, "item"],
    ["unprocessable", false, "item"],
    ["invalid_response", false, "item"],
    ["rate_limited", true, "item"],
    ["server", true, "item"],
    ["timeout", true, "item"],
    ["network", true, "item"],
  ];

  it.each(expected)("%s -> retryable %s, scope %s", (kind, retryable, scope) => {
    const error = new DecisionError({ kind });
    expect(error.retryable).toBe(retryable);
    expect(error.scope).toBe(scope);
    expect(error.code).toBe(`decision_${kind}`);
    expect(error.status).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    expect(error.requestId).toBeNull();
    expect(DECISION_ERROR_RULES[kind]).toEqual({ retryable, scope });
  });

  it("keeps explicit fields", () => {
    const error = new DecisionError({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 2000,
      requestId: "req-1",
    });
    expect([error.status, error.retryAfterMs, error.requestId]).toEqual([429, 2000, "req-1"]);
    expect(error.message).toBe("Decision-1 request failed (rate_limited, HTTP 429)");
  });
});
