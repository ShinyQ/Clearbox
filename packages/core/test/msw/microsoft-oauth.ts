import { http, HttpResponse } from "msw";
import { FakeOAuthState } from "./google-oauth.ts";

export const MICROSOFT_TEST_CLIENT = {
  clientId: "test-ms-client",
  clientSecret: "test-ms-secret",
  redirectUri: "http://localhost:5173/oauth/microsoft/callback",
} as const;

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export function createMicrosoftOAuthState(): FakeOAuthState {
  return new FakeOAuthState({
    prefix: "m",
    grantedScope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
    rotateRefreshTokens: true,
  });
}

function aadError(error: string, code: number, status: number) {
  return HttpResponse.json(
    {
      error,
      error_description: `AADSTS${String(code)}: synthetic description.\r\nTrace ID: 00000000-0000-0000-0000-000000000000`,
      error_codes: [code],
    },
    { status },
  );
}

export function microsoftOAuthHandlers(state: FakeOAuthState) {
  return [
    http.post(TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      state.tokenRequests.push(form);
      const fail = state.failures.take("POST", "/token");
      if (fail)
        return HttpResponse.json(fail.body ?? null, { status: fail.status, headers: fail.headers ?? {} });
      if (form.get("client_id") !== MICROSOFT_TEST_CLIENT.clientId)
        return aadError("unauthorized_client", 700016, 400);
      if (form.get("client_secret") !== MICROSOFT_TEST_CLIENT.clientSecret)
        return aadError("invalid_client", 7000215, 401);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== state.validCode || !form.get("code_verifier"))
          return aadError("invalid_grant", 54005, 400);
        return HttpResponse.json(state.issue(true));
      }
      if (grant === "refresh_token") {
        // Old refresh tokens are not revoked on use (Microsoft docs); the fake keeps them valid too.
        if (!state.refreshTokens.has(form.get("refresh_token") ?? ""))
          return aadError("invalid_grant", 70000, 400);
        return HttpResponse.json(state.issue(state.rotateRefreshTokens));
      }
      return aadError("unsupported_grant_type", 70003, 400);
    }),
    http.all("https://login.microsoftonline.com/*", ({ request }) => {
      const url = new URL(request.url);
      throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
    }),
  ];
}
