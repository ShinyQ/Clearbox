import { http, HttpResponse } from "msw";
import { FailureQueue, type FailRule } from "./failures.ts";

/** In-memory OAuth server state shared by the Google and Microsoft token endpoint fakes. */
export class FakeOAuthState {
  readonly failures = new FailureQueue();
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revoked: string[] = [];
  readonly refreshTokens = new Set<string>();
  validCode = "code-valid";
  grantedScope: string;
  /** Microsoft rotates refresh tokens; Google does not. */
  rotateRefreshTokens: boolean;
  /** When set, the code exchange also returns refresh_token_expires_in (Google time-based access). */
  refreshTokenExpiresIn: number | null = null;
  private issued = 0;
  private readonly prefix: string;

  constructor(options: { prefix: string; grantedScope: string; rotateRefreshTokens: boolean }) {
    this.prefix = options.prefix;
    this.grantedScope = options.grantedScope;
    this.rotateRefreshTokens = options.rotateRefreshTokens;
  }

  failNext(rule: FailRule): void {
    this.failures.add(rule);
  }

  /** Issues an access token and, when withRefresh, a new refresh token that the fake will accept. */
  issue(withRefresh: boolean): Record<string, unknown> {
    this.issued++;
    const body: Record<string, unknown> = {
      access_token: `${this.prefix}-at-${String(this.issued)}`,
      expires_in: 3599,
      token_type: "Bearer",
      scope: this.grantedScope,
    };
    if (withRefresh) {
      const refresh = `${this.prefix}-rt-${String(this.issued)}`;
      this.refreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return body;
  }
}

export const GOOGLE_TEST_CLIENT = {
  clientId: "test-google-client",
  clientSecret: "test-google-secret",
  redirectUri: "http://localhost:5173/oauth/google/callback",
} as const;

export function createGoogleOAuthState(): FakeOAuthState {
  return new FakeOAuthState({
    prefix: "g",
    grantedScope: "https://www.googleapis.com/auth/gmail.modify",
    rotateRefreshTokens: false,
  });
}

function unhandled(request: Request): never {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
}

export function googleOAuthHandlers(state: FakeOAuthState) {
  return [
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      state.tokenRequests.push(form);
      const fail = state.failures.take("POST", "/token");
      if (fail)
        return HttpResponse.json(fail.body ?? null, { status: fail.status, headers: fail.headers ?? {} });
      if (
        form.get("client_id") !== GOOGLE_TEST_CLIENT.clientId ||
        form.get("client_secret") !== GOOGLE_TEST_CLIENT.clientSecret
      ) {
        return HttpResponse.json(
          { error: "invalid_client", error_description: "The OAuth client was not found." },
          { status: 401 },
        );
      }
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== state.validCode || !form.get("code_verifier") || !form.get("redirect_uri")) {
          return HttpResponse.json(
            { error: "invalid_grant", error_description: "Bad Request" },
            { status: 400 },
          );
        }
        const body = state.issue(true);
        if (state.refreshTokenExpiresIn !== null) body.refresh_token_expires_in = state.refreshTokenExpiresIn;
        return HttpResponse.json(body);
      }
      if (grant === "refresh_token") {
        if (!state.refreshTokens.has(form.get("refresh_token") ?? "")) {
          return HttpResponse.json(
            { error: "invalid_grant", error_description: "Token has been expired or revoked." },
            { status: 400 },
          );
        }
        return HttpResponse.json(state.issue(state.rotateRefreshTokens));
      }
      return HttpResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
    }),
    http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
      const token = new URLSearchParams(await request.text()).get("token") ?? "";
      if (!state.refreshTokens.delete(token))
        return HttpResponse.json({ error: "invalid_token" }, { status: 400 });
      state.revoked.push(token);
      return HttpResponse.json({});
    }),
    http.all("https://oauth2.googleapis.com/*", ({ request }) => unhandled(request)),
  ];
}
