# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security > Report a vulnerability** on this repository. Do not open a public issue, and do not include real email content, tokens or keys in the report.

Include the affected version or commit, the steps to reproduce, and the impact you expect. This is a single-maintainer project: expect an acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues. Coordinated disclosure is appreciated; you will be credited unless you prefer otherwise.

In scope: the code in this repository (Worker, SPA, core library, scripts, infrastructure templates). Out of scope: vulnerabilities in Cloudflare, Microsoft, Google or other third-party services (report those to the vendor), and deployments whose owner changed the code or configuration.

## Supported versions

Only the latest commit on `main` receives fixes. Self-hosters should redeploy (`pnpm setup:cf` or `pnpm deploy:cf`) after pulling a security fix.

## Threat model summary

The most valuable asset is a mailbox refresh token; others are email metadata, the Azure API key and the decision history.

| Adversary                                     | Main controls                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated internet user                 | Worker-level Cloudflare Access ("All traffic", owner email only) plus JWT verification in the Worker (RS256 against the team JWKS, `iss`, `aud`, `exp`, owner email); fail closed when configuration is missing; dev bypass only in development mode on localhost |
| Cross-site attacker                           | `X-Clearbox-CSRF: 1` required on mutating API calls, no CORS, `SameSite=Lax` `__Host-` OAuth state cookie with HMAC, PKCE S256                                                                                                                                    |
| Hostile email content (XSS, prompt injection) | Plain-text rendering only, strict CSP, the model returns only bounded probabilities, guardrails based on headers and history, mandatory human approval, trash-only actions                                                                                        |
| Leaked logs                                   | Logs carry opaque ids and counts only; query strings redacted (`redactQueryString`)                                                                                                                                                                               |
| Database exposure                             | Tokens encrypted with AES-256-GCM (AAD binds account, token kind and key version); the key lives only in Worker secrets                                                                                                                                           |
| Supply chain                                  | Exact dependency versions, committed lockfile, Dependabot, CodeQL, actions pinned by commit SHA                                                                                                                                                                   |
| Public repository leak                        | No environment values in tracked files, `scripts/check-text.ts` secret patterns in `pnpm lint`, GitHub secret scanning with push protection, synthetic fixtures only                                                                                              |

The full model and the control list are in the design spec, section 7 (`docs/superpowers/specs/2026-10-15-clearbox-design.md`). Before a first deploy, work through [docs/security-review-checklist.md](docs/security-review-checklist.md).

## Repository settings (maintainers and forks)

Enable these on the GitHub repository (Settings > Code security, or with the GitHub CLI):

```sh
gh api -X PATCH repos/<owner>/<repo> --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts
gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting
```

- Secret scanning with **push protection** blocks pushes that contain known credential formats. If it blocks a push, remove the secret from the commit and rotate it; do not bypass the block for real secrets.
- Dependabot alerts and the weekly version updates in `.github/dependabot.yml`.
- CodeQL runs from `.github/workflows/codeql.yml`; protect `main` with required CI and CodeQL checks.

## If a secret leaks

Rotate it immediately using [docs/runbook.md](docs/runbook.md) (sections 2 to 5), then remove it from git history if it was committed. Rotation, not history rewriting, is what makes a leaked secret harmless.
