import type {
  ActionResult,
  AuthorizeParams,
  BootstrapResult,
  MailProvider,
  OAuthClientConfig,
  OAuthTokens,
  ProviderDeps,
  ProviderKind,
  RestoreItem,
} from "@clearbox/core";
import { PROVIDER_OAUTH } from "../../../src/worker/scan/providers.ts";
import type {
  ProviderFactory,
  ProviderOAuth,
  ProviderOAuthMap,
  ProviderTarget,
} from "../../../src/worker/scan/providers.ts";

export interface FakeCall {
  method: "bootstrap" | "inboxEstimate" | "trash" | "archive" | "restore";
  ids: string[];
  target: ProviderTarget;
}

export interface FakeProviderOptions {
  /** Per provider message id result; default ok with newIdFor(id). */
  results?: ReadonlyMap<string, ActionResult>;
  /** Throw this error from the whole call. */
  failWith?: Partial<Record<FakeCall["method"], Error>>;
  newIdFor?: (id: string) => string;
  bootstrap?: BootstrapResult;
  /** Value returned by inboxEstimate(); default null (unknown). */
  inboxEstimate?: number | null;
}

const DEFAULT_BOOTSTRAP: BootstrapResult = {
  email: "mailbox@example.com",
  providerUserId: "mailbox@example.com",
  aliases: [],
  archiveFolderId: null,
  incrementalCursor: JSON.stringify({ v: 1, historyId: "100" }),
};

/** In-memory MailProvider for worker tests; it calls tokens.getAccessToken() like a real provider. */
export class FakeProvider {
  readonly calls: FakeCall[] = [];
  options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  factory(): ProviderFactory {
    return (target, deps) => this.bind(target, deps);
  }

  private bind(target: ProviderTarget, deps: ProviderDeps): MailProvider {
    const run = async (
      method: FakeCall["method"],
      ids: string[],
      recorded: string[] = ids,
    ): Promise<ActionResult[]> => {
      this.calls.push({ method, ids: recorded, target });
      await deps.tokens.getAccessToken();
      const failure = this.options.failWith?.[method];
      if (failure) throw failure;
      return ids.map(
        (id) => this.options.results?.get(id) ?? { id, ok: true, newId: this.options.newIdFor?.(id) ?? id },
      );
    };
    const unused = (name: string) => async (): Promise<never> => {
      throw new Error(`FakeProvider.${name} is not used by plan 03 tests`);
    };
    return {
      kind: target.provider,
      bootstrap: async () => {
        this.calls.push({ method: "bootstrap", ids: [], target });
        await deps.tokens.getAccessToken();
        const failure = this.options.failWith?.bootstrap;
        if (failure) throw failure;
        return this.options.bootstrap ?? DEFAULT_BOOTSTRAP;
      },
      inboxEstimate: async () => {
        this.calls.push({ method: "inboxEstimate", ids: [], target });
        await deps.tokens.getAccessToken();
        const failure = this.options.failWith?.inboxEstimate;
        if (failure) throw failure;
        return this.options.inboxEstimate ?? null;
      },
      listInboxPage: unused("listInboxPage"),
      listSentPage: unused("listSentPage"),
      syncChanges: unused("syncChanges"),
      resyncCursor: unused("resyncCursor"),
      trash: (ids: readonly string[]) => run("trash", [...ids]),
      archive: (ids: readonly string[]) => run("archive", [...ids]),
      // Calls record restore items as "<from>:<id>"; results are looked up by the raw id.
      restore: (items: readonly RestoreItem[]) =>
        run(
          "restore",
          items.map((i) => i.id),
          items.map((i) => `${i.from}:${i.id}`),
        ),
    };
  }
}

export function fakeProviderFactory(p: FakeProvider): ProviderFactory {
  return p.factory();
}

export interface FakeOAuthCall {
  fn: "authorize" | "exchange" | "refresh" | "revoke";
  provider: ProviderKind;
  value: string;
}

export function fakeOAuth(overrides: Partial<Record<ProviderKind, Partial<ProviderOAuth>>> = {}): {
  oauth: ProviderOAuthMap;
  calls: FakeOAuthCall[];
} {
  const calls: FakeOAuthCall[] = [];
  const make = (provider: ProviderKind): ProviderOAuth => ({
    buildAuthorizeUrl: (cfg: OAuthClientConfig, p: AuthorizeParams) => {
      calls.push({ fn: "authorize", provider, value: p.state });
      const url = new URL(`https://auth.example.test/${provider}/authorize`);
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("state", p.state);
      url.searchParams.set("code_challenge", p.codeChallenge);
      if (p.loginHint !== undefined) url.searchParams.set("login_hint", p.loginHint);
      return url.toString();
    },
    exchangeCode: async (_f, _cfg, code, codeVerifier, now): Promise<OAuthTokens> => {
      calls.push({ fn: "exchange", provider, value: `${code}|${codeVerifier}` });
      return {
        accessToken: "fresh-access",
        expiresAt: now + 3_600_000,
        refreshToken: "fresh-refresh",
        grantedScopes:
          provider === "gmail"
            ? ["https://www.googleapis.com/auth/gmail.modify"]
            : ["Mail.ReadWrite", "offline_access", "User.Read"],
        refreshTokenExpiresAt: null,
      };
    },
    refresh: async (_f, _cfg, refreshToken, now): Promise<OAuthTokens> => {
      calls.push({ fn: "refresh", provider, value: refreshToken });
      return {
        accessToken: "refreshed-access",
        expiresAt: now + 3_600_000,
        refreshToken: provider === "outlook" ? "rotated-refresh" : null,
        grantedScopes: [],
        refreshTokenExpiresAt: null,
      };
    },
    hasRequiredScopes: PROVIDER_OAUTH[provider].hasRequiredScopes,
    revoke:
      provider === "gmail"
        ? async (_f, token) => {
            calls.push({ fn: "revoke", provider, value: token });
            return true;
          }
        : null,
    ...overrides[provider],
  });
  return { oauth: { gmail: make("gmail"), outlook: make("outlook") }, calls };
}
