import type { FetchLike } from "@clearbox/core";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./env.ts";
import { accessGuard } from "./middleware/access.ts";
import { csrfGuard } from "./middleware/csrf.ts";
import { notFoundHandler, onApiError } from "./middleware/errors.ts";
import {
  apiBodyLimit,
  apiResponseHeaders,
  requestContext,
  workerSecureHeaders,
} from "./middleware/headers.ts";
import { accountsRoutes } from "./routes/accounts.ts";
import { meRoutes } from "./routes/me.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { queueRoutes } from "./routes/queue.ts";
import { makeProvider, PROVIDER_OAUTH } from "./scan/providers.ts";
import type { ProviderFactory, ProviderOAuthMap } from "./scan/providers.ts";

export interface AppOverrides {
  fetch?: FetchLike;
  now?: () => number;
  providerFactory?: ProviderFactory;
  oauth?: ProviderOAuthMap;
}

export function defaultDeps(overrides: AppOverrides = {}): AppDeps {
  return {
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    now: overrides.now ?? (() => Date.now()),
    providerFactory: overrides.providerFactory ?? makeProvider,
    oauth: overrides.oauth ?? PROVIDER_OAUTH,
  };
}

/** Contracts 7.1 middleware order: secureHeaders -> accessGuard -> csrfGuard -> routes -> notFound -> onError. */
export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", workerSecureHeaders);
  app.use("*", requestContext(defaultDeps(overrides)));
  app.use("/api/*", apiResponseHeaders);
  app.use("/api/*", accessGuard);
  app.use("/oauth/*", accessGuard);
  app.use("/api/*", csrfGuard);
  app.use("/api/*", apiBodyLimit);

  // Routes (mounted by later tasks, in this order).
  app.route("/oauth", oauthRoutes);
  app.route("/api", meRoutes);
  app.route("/api/accounts", accountsRoutes);
  app.route("/api", queueRoutes);

  app.notFound(notFoundHandler);
  app.onError(onApiError);
  return app;
}
