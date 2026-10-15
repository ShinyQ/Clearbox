import { z } from "zod";
import type { FetchLike } from "@clearbox/core";
import { base64ToBytes } from "./crypto/base64.ts";
import type { ProviderFactory, ProviderOAuthMap } from "./scan/providers.ts";

export const CRON_TICK = "* * * * *";
export const CRON_NIGHTLY = "0 2 * * *";

export type Environment = "development" | "test" | "production";

export interface OAuthClientSecrets {
  clientId: string;
  clientSecret: string;
}

export interface DecisionSecrets {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

export interface AppConfig {
  environment: Environment;
  devAuthBypass: boolean;
  freeTier: boolean;
  ownerEmail: string;
  /** Full origin without trailing slash; equals the Access JWT `iss`. */
  accessTeamDomain: string;
  accessAud: string;
  tokenEncKey: Uint8Array<ArrayBuffer>;
  stateSigningKey: Uint8Array<ArrayBuffer>;
  google: OAuthClientSecrets | null;
  microsoft: OAuthClientSecrets | null;
  decision: DecisionSecrets | null;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; invalid: string[] };

const EnvironmentSchema = z.enum(["development", "test", "production"]);
const FlagSchema = z.enum(["true", "false"]).transform((v) => v === "true");
const OwnerEmailSchema = z.string().trim().toLowerCase().pipe(z.email());
const TeamDomainSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/[A-Za-z0-9.-]+\/?$/)
  .transform((v) => v.replace(/\/$/, ""));
const NonEmptySchema = z.string().trim().min(1);
const Key32Schema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const bytes = base64ToBytes(v);
      if (bytes.length === 32) return bytes;
    } catch {
      // fall through to the issue below
    }
    ctx.addIssue({ code: "custom", message: "expected base64 of exactly 32 bytes" });
    return z.NEVER;
  });
const OptionalSchema = z.string().trim().optional();

const cache = new WeakMap<object, ConfigResult>();

/** Validates every secret and var once per env object (one per isolate in production). Fails closed. */
export function readConfig(env: Env): ConfigResult {
  const hit = cache.get(env);
  if (hit) return hit;
  const result = validate(env as unknown as Record<string, unknown>);
  cache.set(env, result);
  return result;
}

function validate(env: Record<string, unknown>): ConfigResult {
  const invalid: string[] = [];
  function pick<T>(name: string, schema: z.ZodType<T>): T | undefined {
    const parsed = schema.safeParse(env[name]);
    if (!parsed.success) {
      invalid.push(name);
      return undefined;
    }
    return parsed.data;
  }
  function optional(name: string): string {
    const parsed = OptionalSchema.safeParse(env[name]);
    return parsed.success ? (parsed.data ?? "") : "";
  }

  const environment = pick("ENVIRONMENT", EnvironmentSchema);
  const devAuthBypass = pick("DEV_AUTH_BYPASS", FlagSchema);
  const freeTier = pick("FREE_TIER", FlagSchema);
  const ownerEmail = pick("OWNER_EMAIL", OwnerEmailSchema);
  const accessTeamDomain = pick("ACCESS_TEAM_DOMAIN", TeamDomainSchema);
  const accessAud = pick("ACCESS_AUD", NonEmptySchema);
  const tokenEncKey = pick("TOKEN_ENC_KEY", Key32Schema);
  const stateSigningKey = pick("STATE_SIGNING_KEY", Key32Schema);
  if (devAuthBypass === true && environment !== "development") invalid.push("DEV_AUTH_BYPASS");

  if (
    invalid.length > 0 ||
    environment === undefined ||
    devAuthBypass === undefined ||
    freeTier === undefined ||
    ownerEmail === undefined ||
    accessTeamDomain === undefined ||
    accessAud === undefined ||
    tokenEncKey === undefined ||
    stateSigningKey === undefined
  ) {
    return { ok: false, invalid };
  }

  const googleId = optional("GOOGLE_CLIENT_ID");
  const googleSecret = optional("GOOGLE_CLIENT_SECRET");
  const msId = optional("MS_CLIENT_ID");
  const msSecret = optional("MS_CLIENT_SECRET");
  const endpoint = optional("AZURE_DECISION_ENDPOINT").replace(/\/$/, "");
  const apiKey = optional("AZURE_DECISION_KEY");
  const deployment = optional("AZURE_DECISION_DEPLOYMENT");

  return {
    ok: true,
    config: {
      environment,
      devAuthBypass,
      freeTier,
      ownerEmail,
      accessTeamDomain,
      accessAud,
      tokenEncKey,
      stateSigningKey,
      google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
      microsoft: msId && msSecret ? { clientId: msId, clientSecret: msSecret } : null,
      decision: endpoint && apiKey && deployment ? { endpoint, apiKey, deployment } : null,
    },
  };
}

/** Injectable dependencies; tests replace them through createApp(overrides). */
export interface AppDeps {
  fetch: FetchLike;
  now: () => number;
  providerFactory: ProviderFactory;
  oauth: ProviderOAuthMap;
}

export interface AppVariables {
  requestId: string;
  deps: AppDeps;
  /** Set by accessGuard. */
  config: AppConfig;
  /** Set by accessGuard. */
  ownerEmail: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
