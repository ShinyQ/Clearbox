import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CRON_NIGHTLY, CRON_TICK, readConfig } from "../../../src/worker/env.ts";

function withEnv(patch: Record<string, string | undefined>): Env {
  return { ...env, ...patch } as Env;
}

describe("readConfig", () => {
  it("accepts the test environment", () => {
    const result = readConfig(env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environment).toBe("test");
    expect(result.config.ownerEmail).toBe("owner@example.test");
    expect(result.config.accessTeamDomain).toBe("https://test-team.cloudflareaccess.com");
    expect(result.config.tokenEncKey.length).toBe(32);
    expect(result.config.google).toEqual({
      clientId: "test-google-client",
      clientSecret: "test-google-secret",
    });
    expect(result.config.decision?.deployment).toBe("decision-1");
    expect(result.config.freeTier).toBe(true);
  });

  it("caches the result per env object", () => {
    expect(readConfig(env)).toBe(readConfig(env));
  });

  it("fails closed on missing or malformed Access and key secrets", () => {
    const result = readConfig(
      withEnv({
        ACCESS_AUD: "",
        OWNER_EMAIL: "not-an-email",
        TOKEN_ENC_KEY: "AAAA",
        STATE_SIGNING_KEY: undefined,
      }),
    );
    expect(result).toEqual({
      ok: false,
      invalid: ["OWNER_EMAIL", "ACCESS_AUD", "TOKEN_ENC_KEY", "STATE_SIGNING_KEY"],
    });
  });

  it("rejects a non-https team domain", () => {
    const result = readConfig(withEnv({ ACCESS_TEAM_DOMAIN: "http://test-team.cloudflareaccess.com" }));
    expect(result).toEqual({ ok: false, invalid: ["ACCESS_TEAM_DOMAIN"] });
  });

  it("rejects the dev bypass flag outside development", () => {
    const result = readConfig(withEnv({ DEV_AUTH_BYPASS: "true" }));
    expect(result).toEqual({ ok: false, invalid: ["DEV_AUTH_BYPASS"] });
  });

  it("allows the dev bypass flag in development", () => {
    const result = readConfig(withEnv({ ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" }));
    expect(result.ok && result.config.devAuthBypass).toBe(true);
  });

  it("normalizes owner email and team domain", () => {
    const result = readConfig(
      withEnv({
        OWNER_EMAIL: " Owner@Example.TEST ",
        ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com/",
      }),
    );
    expect(result.ok && result.config.ownerEmail).toBe("owner@example.test");
    expect(result.ok && result.config.accessTeamDomain).toBe("https://test-team.cloudflareaccess.com");
  });

  it("treats empty provider and decision secrets as disabled, not invalid", () => {
    const result = readConfig(
      withEnv({ GOOGLE_CLIENT_SECRET: "", MS_CLIENT_ID: "", AZURE_DECISION_KEY: "" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.google).toBeNull();
    expect(result.config.microsoft).toBeNull();
    expect(result.config.decision).toBeNull();
  });

  it("exposes the cron expressions", () => {
    expect(CRON_TICK).toBe("* * * * *");
    expect(CRON_NIGHTLY).toBe("0 2 * * *");
  });
});
