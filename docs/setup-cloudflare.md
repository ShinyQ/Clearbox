# Set up Cloudflare

Clearbox runs as one Cloudflare Worker named `clearbox` (API, cron jobs and the SPA) with one D1 database named `clearbox` in the **EU jurisdiction**, protected by a Cloudflare Access application. Everything fits the Workers Free plan.

Do [setup-azure.md](setup-azure.md) first so you have the Decision-1 endpoint, key and deployment name. Google and Microsoft OAuth clients ([setup-google.md](setup-google.md), [setup-microsoft.md](setup-microsoft.md)) can be added now or later by re-running the setup.

## 1. Prerequisites

| Requirement                         | Check                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account (Free is enough) | You can sign in to the dashboard                                                                                                                                                                      |
| Zero Trust organization             | Dashboard > Zero Trust. The first visit asks for a team name and a plan; the Free plan still asks for payment details but does not charge. Your team domain is `https://<team>.cloudflareaccess.com`. |
| Node.js 24.13 or newer              | `node --version`                                                                                                                                                                                      |
| pnpm 12 (through Corepack)          | `corepack enable && pnpm --version`                                                                                                                                                                   |
| Dependencies installed              | `pnpm install` at the repository root                                                                                                                                                                 |
| Free Cron Trigger slots             | Clearbox needs 2 of the 5 Cron Triggers per account on Workers Free. Check the triggers of your other Workers in the dashboard.                                                                       |

Sign in the `cf` CLI that the project pins (run from the repository root):

```sh
./app/node_modules/.bin/cf auth login
./app/node_modules/.bin/cf auth whoami
```

For automation you can instead export `CLOUDFLARE_API_TOKEN` (permissions: Account D1 Edit, Workers Scripts Edit, Access Apps and Policies Edit) and `CLOUDFLARE_ACCOUNT_ID`. Never put these, or any Worker secret, in a project `.env` file.

## 2. Run the setup script

```sh
pnpm setup:cf
```

The script is interactive and safe to re-run. It:

1. Checks Node.js, pnpm, the `cf` install and the `cf` login.
2. Finds or creates the D1 database: it uses the id in `app/clearbox.local.json` (git-ignored) when present, otherwise looks for a database named `clearbox` and asks whether to use it, otherwise runs `cf d1 create --name clearbox --jurisdiction eu`. It refuses a database whose jurisdiction is not `eu`, and writes the id to `app/clearbox.local.json`.
3. Applies the migrations in `app/migrations` to the remote database (`cf d1 migrations apply <id>`). `cf` may ask you to confirm.
4. Reads the secrets already set on the Worker. If that read fails for any reason other than "Worker not found" (for example a network or permission error), the script stops before generating anything, so a transient error can never replace your keys. Re-run it.
5. Asks for every secret that is not set yet (table below). `TOKEN_ENC_KEY` and `STATE_SIGNING_KEY` are generated (32 random bytes each) and never shown. Credentials are read with hidden input. For secrets that already exist it asks whether to replace them (default: no).
6. Writes the new values to the git-ignored temporary file `app/deploy.secrets.json` (mode 600), runs `pnpm run deploy:cf --secrets-file app/deploy.secrets.json` (which runs `cf deploy --no-provision`) and deletes the file afterwards, even when the deploy fails or you press Ctrl+C. The script then lists the secrets on the Worker and warns about any that are missing.
7. Asks for the Worker URL printed by the deploy (`https://clearbox.<subdomain>.workers.dev`) and stores it in `app/clearbox.local.json`.
8. Prints the Access instructions (section 3) and asks for the AUD tag, then deploys once more with `ACCESS_AUD`.
9. Prints the exact OAuth redirect URIs to register with Google and Microsoft.

`--no-provision` matters: without it `cf deploy` creates missing resources itself, and an auto-created D1 database would not be in the EU jurisdiction. `app/cloudflare.config.ts` also refuses to build for production without a database id.

| Secret                                     | Value                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `AZURE_DECISION_ENDPOINT`                  | `https://<foundry-account>.services.ai.azure.com` (account root, no path)                  |
| `AZURE_DECISION_KEY`                       | Foundry key1 (hidden input)                                                                |
| `AZURE_DECISION_DEPLOYMENT`                | `decision-1` (the deployment name, never `Microsoft-Decision-1`)                           |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google web client; empty id disables Gmail                                                 |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`         | Entra app id and secret value; empty id disables Outlook                                   |
| `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`       | generated                                                                                  |
| `OWNER_EMAIL`                              | the one email allowed in, stored lowercase                                                 |
| `ACCESS_TEAM_DOMAIN`                       | `https://<team>.cloudflareaccess.com` (you can type just `<team>`)                         |
| `ACCESS_AUD`                               | AUD tag of the Access application (section 3). Press Enter to skip it on the first run.    |

On the first run you cannot know the AUD tag yet: the Access application needs the deployed Worker. Press Enter at the `ACCESS_AUD` prompt, finish the first deploy, create the Access application (section 3), then paste the AUD tag when the script asks again. If you quit before that, re-run `pnpm setup:cf` later and enter it.

Until `ACCESS_AUD` and the other Access values are set, every `/api/*` and `/oauth/*` request answers `500 access_misconfigured`. That is intentional: the Worker fails closed.

## 3. Protect the Worker with Cloudflare Access

Access must protect **all traffic** of the Worker, including the `workers.dev` URL. The Worker also verifies the Access JWT itself on `/api/*` and `/oauth/*` (static assets are served without invoking the Worker).

Dashboard:

1. Workers & Pages > `clearbox` > Settings > Access (or the Access tab) > **Protect this Worker behind Access**.
2. Choose **All traffic**, pick any policy, then **Apply Access**.
3. Zero Trust > Access controls > Applications > the new application > Policies: make the only Allow rule **Include: Emails = `<you@example.com>`** (the same value as `OWNER_EMAIL`). Remove broader rules such as "Cloudflare account" or "Email domain".
4. Same application > Configure > Additional settings: copy the **Application Audience (AUD) tag** and paste it when `pnpm setup:cf` asks for `ACCESS_AUD`.

CLI alternative (from the repository root; the response contains `aud`):

```sh
./app/node_modules/.bin/cf workers get clearbox   # note the "id" field
./app/node_modules/.bin/cf zero-trust access applications create --body '{
  "type": "self_hosted",
  "name": "Clearbox",
  "destinations": [{ "type": "worker", "worker_id": "<worker-id>" }],
  "policies": [{ "decision": "allow", "include": [{ "email": { "email": "<you@example.com>" } }] }]
}'
```

Check it:

```sh
curl -sI https://clearbox.<subdomain>.workers.dev/api/me | head -n 3
```

Expected: a `302` redirect to `https://<team>.cloudflareaccess.com/...` (Access answers before the Worker runs; you never get a Clearbox JSON response without signing in). In a private browser window, the URL shows the Access login page; after signing in with `OWNER_EMAIL` (one-time PIN works) you see the Clearbox dashboard. With no mailbox connected it opens the **Setup** page, where you connect Gmail or Outlook ([setup-google.md](setup-google.md), [setup-microsoft.md](setup-microsoft.md)).

## 4. Re-running and changing secrets

- `pnpm setup:cf` again: reuses the database, keeps existing keys, asks per secret whether to replace it, deploys the current code.
- Rotate the OAuth state key: `pnpm setup:cf --rotate-state-key` (only in-flight connect flows are affected).
- Rotate the token key: `pnpm setup:cf --rotate-token-key`. The script asks you to type `rotate` first. Read [runbook.md](runbook.md) before you do: every account must **Reconnect**.
- Single secret without the script: `./app/node_modules/.bin/cf workers secrets update <NAME> --worker clearbox` (the value may be left in your shell history), or `npx wrangler secret put <NAME> --name clearbox`.
- Deploy code only: `pnpm deploy:cf` (needs `app/clearbox.local.json` or `CLEARBOX_D1_ID`).

## 5. Local development

```sh
cp app/.dev.vars.example app/.dev.vars   # fill in values; the file is git-ignored
pnpm db:migrate:local                    # local D1 in app/.cloudflare/state
pnpm dev                                 # http://localhost:5173
```

- Local mode skips Access only on `localhost` / `127.0.0.1` in development mode. Production builds always verify the JWT.
- Trigger the cron jobs: `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=*+*+*+*+*"` (tick) and `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=0+2+*+*+*"` (nightly).
- OAuth locally needs `http://localhost:5173/oauth/google/callback` and `http://localhost:5173/oauth/microsoft/callback` registered as extra redirect URIs.

## 6. Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No D1 database id. Run pnpm setup:cf or set CLEARBOX_D1_ID` | Run `pnpm setup:cf`, or export `CLEARBOX_D1_ID=<d1-id>`                                                                                                                                                                                                                                                                  |
| `cf is not logged in`                                        | `./app/node_modules/.bin/cf auth login`                                                                                                                                                                                                                                                                                  |
| `Could not list secrets on Worker "clearbox"`                | A transient or permission error. Nothing was changed. Check `cf auth whoami` and re-run `pnpm setup:cf`.                                                                                                                                                                                                                 |
| `jurisdiction "us"` (or other)                               | The existing database is not EU. Create a new one (delete or rename the old one, delete `app/clearbox.local.json`, re-run). The jurisdiction cannot be changed after creation.                                                                                                                                           |
| `500 access_misconfigured`                                   | A required secret is missing or malformed (`OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`), `AZURE_DECISION_ENDPOINT` is not the https account root (no path, query, fragment or credentials), or `AZURE_DECISION_DEPLOYMENT` is `Microsoft-Decision-1` (that is the model name, not a deployment name). Re-run `pnpm setup:cf`.                                                                                                                                                             |
| `403 forbidden` after Access login                           | `OWNER_EMAIL` differs from the Access login email, or `ACCESS_AUD` belongs to another application.                                                                                                                                                                                                                       |
| The first deploy is rejected because `ACCESS_AUD` is missing | Re-run `pnpm setup:cf` and enter a placeholder such as `pending-access-application-setup-0000` for `ACCESS_AUD` (the Worker still rejects every request, because no Access JWT carries that audience), then create the Access application and replace the value with its real AUD tag.                                  |
| Cron jobs never run                                          | Account already uses 5 Cron Triggers; remove one from another Worker.                                                                                                                                                                                                                                                    |

## 7. Workers Paid

On Workers Paid you can lift the Free limits: set `FREE_TIER: bindings.text("false")` in `app/cloudflare.config.ts` (page size 100, no D1 write budget gate) and deploy with `pnpm deploy:cf`. Nothing else changes.
