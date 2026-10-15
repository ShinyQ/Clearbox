import * as core from "@clearbox/core";
import type { MailProvider, TokenUpdate } from "@clearbox/core";
import {
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  createSubrequestCounter,
} from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { decryptToken, encryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import type { EncryptedValue } from "../../../src/worker/crypto/aead.ts";
import { chunk, withCount } from "../../../src/worker/db/sql.ts";
import { readConfig } from "../../../src/worker/env.ts";
import type { AppConfig } from "../../../src/worker/env.ts";
import { logEvent } from "../../../src/worker/log.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";
import { accountsRoutes } from "../../../src/worker/routes/accounts.ts";
import { PROVIDER_OAUTH, makeProvider } from "../../../src/worker/scan/providers.ts";
import { createD1TokenSource, refreshFnFor } from "../../../src/worker/scan/token-source.ts";
import type { D1TokenSource } from "../../../src/worker/scan/token-source.ts";
import { apiFetch } from "../helpers/request.ts";
import { network } from "../setup/network.ts";

const CORE_FUNCTIONS = [
  "extractSignals",
  "evaluateGuardrails",
  "selectPrior",
  "priorKeyForSender",
  "priorKeyForDomain",
  "buildDecisionState",
  "decisionSeed",
  "decideAll",
  "fuse",
  "parsePolicy",
  "calibrateTauDelete",
  "createSubrequestCounter",
  "countingFetch",
  "backoffMs",
  "createGmailProvider",
  "createGraphProvider",
  "refreshGoogleToken",
  "refreshMicrosoftToken",
] as const;

describe("upstream surfaces used by the scan pipeline", () => {
  it("core exports every function the pipeline calls", () => {
    const exported = core as unknown as Record<string, unknown>;
    for (const name of CORE_FUNCTIONS) expect(typeof exported[name], name).toBe("function");
    expect(typeof makeMailMessage).toBe("function");
  });

  it("plan 01 to 03 signatures match what this plan calls (checked by pnpm typecheck)", () => {
    const key = {} as CryptoKey;
    const ctx = { accountId: "acc_0000000000000000", kind: "refresh" as const, keyVersion: 1 };
    const value: EncryptedValue = { ciphertext: new Uint8Array(16), iv: new Uint8Array(12) };
    const tokens = { getAccessToken: async () => "t", forceRefresh: async () => "t" };
    expectTypeOf(readConfig).returns.toEqualTypeOf<
      { ok: true; config: AppConfig } | { ok: false; invalid: string[] }
    >();
    expectTypeOf(importEncKey).toBeCallableWith(new Uint8Array(32));
    expectTypeOf(importEncKey).returns.resolves.toEqualTypeOf<CryptoKey>();
    expectTypeOf(encryptToken).toBeCallableWith(key, "token", ctx);
    expectTypeOf(encryptToken).returns.resolves.toEqualTypeOf<EncryptedValue>();
    expectTypeOf(decryptToken).toBeCallableWith(key, value, ctx);
    expectTypeOf(decryptToken).returns.resolves.toEqualTypeOf<string>();
    expectTypeOf(withCount<number>).toBeCallableWith(createSubrequestCounter(1), async () => 1);
    expectTypeOf(chunk<number>).toBeCallableWith([1, 2, 3], 2);
    expectTypeOf(chunk<number>).returns.toEqualTypeOf<number[][]>();
    expectTypeOf(logEvent).toBeCallableWith("tick.idle", { tickId: "t", trigger: "cron" });
    expectTypeOf(ApiError).toBeConstructibleWith(409, "account_busy", "busy", {
      retryAt: "2026-10-15T12:00:00.000Z",
    });
    expectTypeOf<ApiError>().toHaveProperty("status");
    expectTypeOf<ApiError>().toHaveProperty("code");
    expectTypeOf<D1TokenSource["update"]>().toEqualTypeOf<TokenUpdate | null>();
    expectTypeOf(createD1TokenSource).returns.toEqualTypeOf<D1TokenSource>();
    expectTypeOf(refreshFnFor).toBeCallableWith(PROVIDER_OAUTH, {} as AppConfig, "gmail", fetch, () => 0, "");
    expectTypeOf(makeProvider).toBeCallableWith(
      { provider: "outlook", archiveFolderId: null },
      { fetch, tokens, now: () => 0 },
    );
    expectTypeOf(accountsRoutes.post).toBeFunction();
    expectTypeOf(network.use).toBeFunction();
    expectTypeOf(apiFetch).toBeCallableWith("/api/accounts", { method: "POST" });
    expectTypeOf(ProviderAuthError).toBeConstructibleWith({ provider: "gmail", reason: "invalid_grant" });
    expectTypeOf(ProviderConfigError).toBeConstructibleWith({
      provider: "outlook",
      reason: "invalid_client",
    });
    expectTypeOf(ProviderRateLimitError).toBeConstructibleWith({ provider: "outlook", retryAfterMs: 1000 });
    expectTypeOf(DecisionError).toBeConstructibleWith({
      kind: "server",
      status: 503,
      retryable: true,
      scope: "item",
      retryAfterMs: null,
      requestId: null,
    });
    expectTypeOf(core.ClearboxError).toBeConstructibleWith("decision_outage", "message");
    expectTypeOf(core.ProviderUnavailableError).toBeConstructibleWith({
      provider: "outlook",
      retryAfterMs: null,
      cause: new Error("x"),
    });
    expectTypeOf<MailProvider["inboxEstimate"]>().toEqualTypeOf<() => Promise<number | null>>();
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 90)).toEqual([]);
  });
});
