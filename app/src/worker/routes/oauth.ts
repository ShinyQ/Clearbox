import type { AuthorizeParams, ProviderKind } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { OAuthCallbackErrorCode } from "../../shared/api.ts";
import { importSigningKey } from "../crypto/hmac.ts";
import { challengeS256 } from "../crypto/pkce.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { notFoundHandler } from "../middleware/errors.ts";
import { completeConnect } from "../oauth/connect.ts";
import { CLEAR_OAUTH_COOKIE, createOAuthState, verifyOAuthState } from "../oauth/state-cookie.ts";
import { callbackPath, oauthClientConfig } from "../scan/providers.ts";

const SEGMENTS: Readonly<Record<string, ProviderKind>> = { google: "gmail", microsoft: "outlook" };
const LoginHintSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const oauthRoutes = new Hono<AppEnv>();

function providerFor(c: Context<AppEnv>): ProviderKind | null {
  return SEGMENTS[c.req.param("segment") ?? ""] ?? null;
}

function toSettings(c: Context<AppEnv>, params: Record<string, string>): Response {
  c.header("Cache-Control", "no-store");
  return c.redirect(`/settings/accounts?${new URLSearchParams(params).toString()}`, 302);
}

oauthRoutes.get("/:segment/start", async (c) => {
  const provider = providerFor(c);
  if (!provider) return notFoundHandler(c);
  const config = c.get("config");
  const deps = c.get("deps");
  const cfg = oauthClientConfig(config, provider, new URL(c.req.url).origin + callbackPath(provider));
  if (!cfg) return toSettings(c, { error: "provider_not_configured", provider });

  const state = await createOAuthState(await importSigningKey(config.stateSigningKey), provider, deps.now());
  const params: AuthorizeParams = {
    state: state.payload.n,
    codeChallenge: await challengeS256(state.payload.v),
  };
  const hint = LoginHintSchema.safeParse(c.req.query("loginHint"));
  if (hint.success) params.loginHint = hint.data;
  c.header("Set-Cookie", state.setCookie);
  c.header("Cache-Control", "no-store");
  return c.redirect(deps.oauth[provider].buildAuthorizeUrl(cfg, params), 302);
});

async function handleCallback(
  c: Context<AppEnv>,
  provider: ProviderKind,
): Promise<
  { ok: true; accountId: string; reconnected: boolean } | { ok: false; error: OAuthCallbackErrorCode }
> {
  const config = c.get("config");
  const deps = c.get("deps");
  const providerError = c.req.query("error");
  if (providerError !== undefined) {
    const description = c.req.query("error_description") ?? "";
    const admin =
      provider === "outlook" && (providerError === "consent_required" || description.includes("AADSTS90094"));
    return { ok: false, error: admin ? "admin_consent_required" : "access_denied" };
  }
  const verified = await verifyOAuthState(
    await importSigningKey(config.stateSigningKey),
    c.req.header("Cookie") ?? null,
    provider,
    c.req.query("state") ?? null,
    deps.now(),
  );
  if (!verified.ok) return { ok: false, error: "state_invalid" };
  const code = c.req.query("code");
  if (!code) return { ok: false, error: "token_exchange_failed" };
  const redirectUri = new URL(c.req.url).origin + callbackPath(provider);
  if (!oauthClientConfig(config, provider, redirectUri))
    return { ok: false, error: "provider_not_configured" };
  return completeConnect({ db: c.env.DB, config, deps, redirectUri }, provider, code, verified.payload.v);
}

oauthRoutes.get("/:segment/callback", async (c) => {
  const provider = providerFor(c);
  if (!provider) return notFoundHandler(c);
  c.header("Set-Cookie", CLEAR_OAUTH_COOKIE);
  let result: Awaited<ReturnType<typeof handleCallback>>;
  try {
    result = await handleCallback(c, provider);
  } catch {
    result = { ok: false, error: "token_exchange_failed" };
  }
  if (result.ok) {
    logEvent("oauth.connect", {
      provider,
      outcome: result.reconnected ? "reconnected" : "connected",
      accountId: result.accountId,
    });
    return toSettings(c, { connected: result.accountId });
  }
  logEvent("oauth.connect", { provider, outcome: result.error, accountId: null });
  return toSettings(c, { error: result.error, provider });
});
