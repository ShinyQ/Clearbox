import { describe, expect, expectTypeOf, it } from "vitest";
import type { FetchLike } from "../../src/http/fetch.ts";
import {
  GOOGLE_SCOPES,
  MICROSOFT_CONSENT_URLS,
  MICROSOFT_SCOPES,
  type AuthorizeParams,
  type OAuthClientConfig,
} from "../../src/providers/oauth.ts";
import type {
  ActionResult,
  ChangesPage,
  GraphProviderDeps,
  MailProvider,
  ProviderDeps,
  RestoreItem,
} from "../../src/providers/provider.ts";
import type { OAuthTokens, TokenSource, TokenUpdate } from "../../src/providers/token.ts";

/** A minimal in-memory provider proves the interface is implementable as declared. */
function stubProvider(): MailProvider {
  const ok = (ids: readonly string[]): Promise<ActionResult[]> =>
    Promise.resolve(ids.map((id) => ({ id, ok: true as const, newId: id })));
  return {
    kind: "gmail",
    bootstrap: () =>
      Promise.resolve({
        email: "owner@example.test",
        providerUserId: "owner@example.test",
        aliases: [],
        archiveFolderId: null,
        incrementalCursor: '{"v":1,"historyId":"1","catchupAfter":null,"catchupPageToken":null}',
      }),
    listInboxPage: () => Promise.resolve({ messages: [], nextCursor: null }),
    listSentPage: () => Promise.resolve({ items: [], nextCursor: null }),
    syncChanges: (cursor) =>
      Promise.resolve<ChangesPage>({
        added: [],
        removedIds: [],
        sent: [],
        nextCursor: cursor,
        caughtUp: true,
      }),
    resyncCursor: () => Promise.resolve("{}"),
    trash: ok,
    archive: ok,
    restore: (items: readonly RestoreItem[]) => ok(items.map((i) => i.id)),
  };
}

describe("provider interfaces", () => {
  it("can be implemented and has no hard-delete method", async () => {
    const provider = stubProvider();
    expect(await provider.trash(["a"])).toEqual([{ id: "a", ok: true, newId: "a" }]);
    expect("delete" in provider).toBe(false);
    expectTypeOf<MailProvider>().not.toHaveProperty("delete");
  });

  it("declares dependency, token and OAuth shapes", () => {
    expectTypeOf<ProviderDeps>().toHaveProperty("fetch").toEqualTypeOf<FetchLike>();
    expectTypeOf<ProviderDeps>().toHaveProperty("tokens").toEqualTypeOf<TokenSource>();
    expectTypeOf<GraphProviderDeps>().toHaveProperty("archiveFolderId").toEqualTypeOf<string | null>();
    expectTypeOf<TokenUpdate>().toEqualTypeOf<{
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string | null;
    }>();
    expectTypeOf<OAuthTokens>().toHaveProperty("refreshTokenExpiresAt").toEqualTypeOf<number | null>();
    expectTypeOf<OAuthClientConfig>().toHaveProperty("redirectUri").toEqualTypeOf<string>();
    expectTypeOf<AuthorizeParams>().toHaveProperty("loginHint").toEqualTypeOf<string | undefined>();
  });

  it("exports scope and consent constants", () => {
    expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(MICROSOFT_SCOPES).toEqual(["offline_access", "User.Read", "Mail.ReadWrite"]);
    expect(MICROSOFT_CONSENT_URLS).toEqual({
      personal: "https://account.live.com/consent/Manage",
      work: "https://myapps.microsoft.com",
    });
  });
});
