import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/.cloudflare/**", "**/coverage/**", "pnpm-lock.yaml"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.es2024 } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Contracts 3.8 (rev 2.2): plain "error"; ESLint 10 rejects an empty allow list.
      "no-console": "error",
    },
  },
  {
    files: ["app/src/web/**"],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["packages/core/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["cloudflare:*", "hono", "hono/*", "@cloudflare/*", "node:*", "react", "react-dom"],
              message: "@clearbox/core is pure TypeScript: no Cloudflare, Hono, Node or React imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/web/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../worker/*", "**/worker/**", "cloudflare:*", "hono"],
              message: "The SPA must not import Worker code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/worker/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "**/web/**"], message: "The Worker must not import SPA code." },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/worker/log.ts", "scripts/**", "eval/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
  {
    files: ["**/test/**", "**/*.config.ts", "**/*.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
