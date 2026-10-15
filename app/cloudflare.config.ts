import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/** Local (dev and test) D1 is keyed by this fixed UUID; remote uses the real EU database. */
const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";

function remoteD1Id(): string {
  const fromEnv = process.env.CLEARBOX_D1_ID;
  if (fromEnv) return fromEnv;
  const file = path.join(import.meta.dirname, "clearbox.local.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { d1DatabaseId?: string };
    if (parsed.d1DatabaseId) return parsed.d1DatabaseId;
  }
  throw new Error(
    "No D1 database id. Run `pnpm setup:cf` or set CLEARBOX_D1_ID. Refusing to continue so cf cannot auto-provision a non-EU database.",
  );
}

export default defineConfig((ctx) => {
  const mode = ctx.mode ?? "production";
  const isLocal = mode === "development" || mode === "test";
  const environment = mode === "development" ? "development" : mode === "test" ? "test" : "production";

  return {
    worker: {
      name: "clearbox",
      entrypoint,
      // Must not exceed the workerd date shipped with miniflare 5.20261012.
      compatibilityDate: "2026-10-12",
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/oauth/*"],
      },
      env: {
        DB: bindings.d1({ id: isLocal ? LOCAL_D1_ID : remoteD1Id(), name: "clearbox" }),
        ENVIRONMENT: bindings.text(environment),
        DEV_AUTH_BYPASS: bindings.text(mode === "development" ? "true" : "false"),
        FREE_TIER: bindings.text("true"),
        AZURE_DECISION_ENDPOINT: bindings.secret(),
        AZURE_DECISION_KEY: bindings.secret(),
        AZURE_DECISION_DEPLOYMENT: bindings.secret(),
        GOOGLE_CLIENT_ID: bindings.secret(),
        GOOGLE_CLIENT_SECRET: bindings.secret(),
        MS_CLIENT_ID: bindings.secret(),
        MS_CLIENT_SECRET: bindings.secret(),
        TOKEN_ENC_KEY: bindings.secret(),
        STATE_SIGNING_KEY: bindings.secret(),
        OWNER_EMAIL: bindings.secret(),
        ACCESS_TEAM_DOMAIN: bindings.secret(),
        ACCESS_AUD: bindings.secret(),
      },
      triggers: [
        triggers.scheduled({ schedule: "* * * * *" }),
        triggers.scheduled({ schedule: "0 2 * * *" }),
      ],
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: true },
      },
      workersDev: true,
      previewUrls: false,
    },
  };
});
