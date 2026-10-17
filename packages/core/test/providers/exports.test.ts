import { describe, expect, it } from "vitest";
import * as core from "../../src/index.ts";
import * as testing from "../testing.ts";

const PROVIDER_EXPORTS = [
  "buildAuthorizeUrl",
  "exchangeCode",
  "refreshAccessToken",
  "parseTokenResponse",
  "buildBatchBody",
  "parseBatchResponse",
  "boundaryFromContentType",
  "GMAIL_MODIFY_SCOPE",
  "GOOGLE_TOKEN_ENDPOINT",
  "buildGoogleAuthorizeUrl",
  "exchangeGoogleCode",
  "refreshGoogleToken",
  "revokeGoogleToken",
  "hasGmailScope",
  "classifyGoogleOAuthError",
  "classifyGmailApiError",
  "mapGmailMessage",
  "buildGmailDeepLink",
  "createGmailProvider",
  "MICROSOFT_TOKEN_ENDPOINT",
  "buildMicrosoftAuthorizeUrl",
  "exchangeMicrosoftCode",
  "refreshMicrosoftToken",
  "hasGraphScopes",
  "classifyMicrosoftOAuthError",
  "classifyGraphApiError",
  "mapGraphMessage",
  "createGraphProvider",
] as const;

const TESTING_EXPORTS = [
  "makeGmailMetadata",
  "makeGraphMessage",
  "FAKE_OWNER",
  "FakeMailbox",
  "FakeTokenSource",
  "gmailHandlers",
  "graphHandlers",
  "FakeOAuthState",
  "GOOGLE_TEST_CLIENT",
  "createGoogleOAuthState",
  "googleOAuthHandlers",
  "MICROSOFT_TEST_CLIENT",
  "createMicrosoftOAuthState",
  "microsoftOAuthHandlers",
] as const;

describe("@clearbox/core provider exports", () => {
  it.each(PROVIDER_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
  });

  it("providers expose the MailProvider surface and no hard delete", () => {
    const deps = {
      fetch: () => Promise.reject(new Error("unused")),
      tokens: { getAccessToken: () => Promise.resolve("t"), forceRefresh: () => Promise.resolve("t") },
      now: () => 0,
    };
    for (const provider of [
      core.createGmailProvider(deps),
      core.createGraphProvider({ ...deps, archiveFolderId: null }),
    ]) {
      expect(Object.keys(provider).sort()).toEqual(
        [
          "archive",
          "bootstrap",
          "inboxEstimate",
          "kind",
          "listInboxPage",
          "listSentPage",
          "restore",
          "resyncCursor",
          "syncChanges",
          "trash",
          "unsubscribeHeaders",
        ].sort(),
      );
    }
  });
});

describe("@clearbox/core/testing provider helpers", () => {
  it.each(TESTING_EXPORTS)("exports %s", (name) => {
    expect(testing).toHaveProperty(name);
  });
});
