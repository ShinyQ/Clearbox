import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      experimental: { newConfig: true },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          ENVIRONMENT: "test",
          DEV_AUTH_BYPASS: "false",
          FREE_TIER: "true",
          AUTO_TRASH_KILL_SWITCH: "off",
          OWNER_EMAIL: "owner@example.test",
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-0000000000000000000000000000000000000000000000000000000000",
          TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          STATE_SIGNING_KEY: "HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=",
          AZURE_DECISION_ENDPOINT: "https://decision.example.test",
          AZURE_DECISION_KEY: "test-key",
          AZURE_DECISION_DEPLOYMENT: "decision-1",
          GOOGLE_CLIENT_ID: "test-google-client",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          MS_CLIENT_ID: "test-ms-client",
          MS_CLIENT_SECRET: "test-ms-secret",
        },
      },
    })),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["test/worker/setup/apply-migrations.ts", "test/worker/setup/network.ts"],
    // The workerd pool cannot read Vitest 5's on-disk module cache (default on).
    fsModuleCache: false,
  },
});
