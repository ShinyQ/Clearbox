# Clearbox runbook

Operational procedures for a running deployment. Commands run from the repository root. `CF` below means `./app/node_modules/.bin/cf`, and `<d1-id>` is the `d1DatabaseId` in `app/clearbox.local.json`.

Queries you run against D1 count toward the daily rows read and written, like the app's own. `d1 raw` returns rows as arrays; the SQL is passed with `--sql=` so a leading `--` is never read as a flag.

## 1. Where to look

| Source                                                       | What it tells you                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clearbox banners and the Accounts page                       | App issues (`decision_not_configured`, `decision_auth_failed`, `decision_deployment_not_found`, `google_client_invalid`, `microsoft_client_invalid`, `storage_near_limit`, `budget_exhausted_today`) and per-account status (`active`, `needs_reauth`, `config_error`) |
| Insights page                                                | Today's D1 budget, database size, `tau_delete`, calibration, sync status                                                                                                                                                                                               |
| Workers Logs (dashboard > Workers & Pages > clearbox > Logs) | JSON events: `tick.claimed`, `tick.done`, `tick.failed`, `tick.idle`, `decision.error`, `provider.error`, `access.denied`, `config.invalid`, `budget.gate`, `account.status`, `action.executed`, `undo.done`, `nightly.done`, `reminder.done`, `issue.raised`, `issue.cleared`          |
| Live tail                                                    | `npx wrangler tail clearbox`                                                                                                                                                                                                                                           |
| Budget history                                               | `$CF d1 raw <d1-id> --sql="SELECT date, rows_written, ticks, messages_ingested, decision_failures FROM budget ORDER BY date DESC LIMIT 7"`                                                                                                                             |

Logs never contain addresses, subjects, tokens or URLs, only ids and counts.

## 2. Rotate TOKEN_ENC_KEY

`TOKEN_ENC_KEY` encrypts every stored OAuth token (AES-256-GCM, AAD `clearbox|<accountId>|<kind>|v<keyVersion>`). Clearbox v1 holds one key at a time, so rotation means reconnecting every account (fresh tokens are issued and encrypted under the new key). `accounts.key_version` stays `1`; it is reserved for a future dual-key rotation.

When: the key may have leaked, or as yearly hygiene.

1. In Clearbox, on the **Accounts** page: **Pause** every account (no tick will try to decrypt with the new key).
2. `pnpm setup:cf --rotate-token-key`, type `rotate` when asked, keep every other secret (answer no to each "Replace it?" prompt). The script generates the new key, deploys it and never shows it.
3. Reconnect every account. A paused account does not show a **Reconnect** button, so on the **Accounts** page click **Connect Gmail** or **Connect Outlook** (or **Add account** in the sidebar) and sign in with the same mailbox. Pick that exact mailbox in the Google or Microsoft account picker: a different one creates a second account, so check afterwards that the account count did not grow. Clearbox recognises the mailbox and reconnects it in place: fresh tokens encrypted with the new key, cursors, suggestions, labels and priors kept. An account that was not paused and already failed a tick shows **Reconnect** on its card instead. Do not **Undo** or **Clean up** on a paused account until it is reconnected.
4. **Resume** each account and click **Scan now** once to confirm (`tick.done` in the logs).
5. If the old key leaked: also revoke the old grants (Google: https://myaccount.google.com/permissions, then reconnect; Microsoft: reconnect issues new tokens, and an admin can revoke sessions for work accounts).

An account you forget to reconnect stays paused and silently stops syncing. It becomes `needs_reauth` (ticks fail safely, no actions) only if you resume it before reconnecting. Either way, reconnect it.

## 3. Rotate STATE_SIGNING_KEY

`pnpm setup:cf --rotate-state-key`. Only connect flows started in the last 10 minutes fail (`state_invalid`); start them again.

## 4. Rotate the Azure key

1. Switch Clearbox to key2: `az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key2 --output tsv | pbcopy` (Linux: pipe to `xclip -selection clipboard`), then `pnpm setup:cf` and replace `AZURE_DECISION_KEY`.
2. Regenerate key1: `az cognitiveservices account keys regenerate --resource-group <resource-group> --name <foundry-account> --key-name key1 --output none`.
3. Next time, rotate the other way round.

## 5. Rotate the Google or Entra client secret

- Entra secrets expire (AADSTS7000222). Before expiry: Certificates & secrets > New client secret, `pnpm setup:cf` to replace `MS_CLIENT_SECRET`, then delete the old secret. Existing tokens keep working.
- Google: Clients > Clearbox > Add secret, replace `GOOGLE_CLIENT_SECRET` with `pnpm setup:cf`, then disable and delete the old secret.
- After an expiry already happened: accounts show `config_error` ("Microsoft sign-in is misconfigured." or "Google sign-in is misconfigured."); replace the secret, then **Reconnect** each affected account.

## 6. Re-authentication (`needs_reauth`)

Causes: revoked consent, password change (Gmail), 6 months unused (Gmail), Testing-mode app (Gmail, 7 days), Conditional Access or MFA requirement (Microsoft), refresh token expiry (Microsoft, 90 days unused), or a changed `TOKEN_ENC_KEY` (section 2). Fix: **Reconnect** on the account card (Accounts page) or in the Review banner. Repeated weekly Gmail re-auth means the consent screen is still in Testing ([setup-google.md](setup-google.md)).

## 7. Configuration errors (`config_error`)

Owner-side credential problems (`invalid_client`, `unauthorized_client`, `deleted_client`, AADSTS7000215, AADSTS7000222, AADSTS50011, AADSTS50194, AADSTS700016). The app banner names the provider. Fix the client in Google or Entra, update the secrets with `pnpm setup:cf`, then **Reconnect** the affected accounts.

## 8. Purge and data removal

- Automatic: the nightly job (02:00 UTC) deletes suggestions and messages 30 days after a decision (90 days if never reviewed) and action batches after 7 days, in bounded chunks.
- One account: **Accounts** page, **Disconnect** on its card. Tokens are wiped at once (Google token revoked); messages, suggestions, labels, priors and sender data are purged by the following nightly runs; the audit log keeps counts only.
- Everything: disconnect all accounts and wait for the purge, or delete the resources:

  ```sh
  $CF workers delete clearbox
  $CF d1 delete <d1-id>
  rm app/clearbox.local.json
  ```

  Then delete the Access application (Zero Trust > Access controls > Applications) and, if wanted, the Azure deployment and the OAuth clients.

- Undo a bad database change (for example a wrong manual query): D1 Time Travel restores to any point in the last 7 days (Free). The restore overwrites the current data, so everything written after that time is lost. Note the current bookmark first so you can go back:

  ```sh
  $CF d1 time-travel get-bookmark <d1-id>
  $CF d1 time-travel restore <d1-id> --timestamp 2026-10-15T08:00:00Z
  ```

## 9. Restore mail

- Within 24 hours: select the batch in Clearbox (**Activity**, or **Undo** in the confirmation toast) and click **Undo**. Trashed mail and archived mail both return to the inbox. Keep decisions are not undone: a keep never moved anything, so there is nothing to restore.
- After 24 hours: Clearbox never deletes permanently. Gmail: open Trash (kept about 30 days) and choose "Move to inbox"; archived mail is under All Mail. Outlook: Deleted Items (retention depends on the mailbox policy, often 30 days) and the Archive folder.
- Then add the sender to **Always keep** (the "Always keep" action on a suggestion, or **Rules**) so it is not suggested for deletion again.

## 10. D1 budget exhaustion

Free D1 allows 100,000 rows written per day (reset 00:00 UTC). Clearbox stops claiming ticks at 65,000, stops the nightly purge at 80,000 and refuses owner actions with `budget_exhausted` at 90,000 (`budget.gate` events).

- Usually expected during the first backfill: scanning resumes after 00:00 UTC.
- If owner actions are refused, wait for the UTC reset.
- To go faster permanently: Workers Paid and `FREE_TIER` `"false"` ([setup-cloudflare.md](setup-cloudflare.md), section 7).

Storage: backfill pauses at 450 MB of the 500 MB per-database limit (`storage_near_limit`). Review and decide pending suggestions so the purge can remove decided rows, or disconnect accounts you no longer need.

## 11. Decision-1 outage or errors

| Signal                                                               | Meaning                            | Action                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue `decision_not_configured`                                      | `AZURE_DECISION_*` secrets missing | `pnpm setup:cf`                                                                                                                                             |
| Issue `decision_auth_failed`, `decision.error` kind `auth` (401/403) | Key wrong or rotated               | Replace `AZURE_DECISION_KEY` (section 4)                                                                                                                    |
| Issue `decision_deployment_not_found` (404)                          | Deployment deleted or renamed      | `infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --existing`, check `AZURE_DECISION_DEPLOYMENT`               |
| Many `rate_limited` (429)                                            | Capacity too low                   | Re-run the deploy script with a higher `--capacity`                                                                                                         |
| `server`, `timeout`, `network`                                       | Azure incident                     | Nothing to do: suggestions wait as `awaiting_model`, retry after 5 and 30 minutes, then fall back to `unsure` with "Model unavailable". Check Azure status. |
| Many `invalid_response`                                              | API shape changed (Preview model)  | Check the release notes; update the schema in `packages/core/src/decision/response.ts`; run `pnpm eval`                                                     |

Nothing is ever executed without your approval, so an outage only delays suggestions.

### Version retirement (2027-02-04)

Microsoft-Decision-1 version 1 stops serving on 2027-02-04. Weeks before:

1. Deploy the new version under a new name (for example `decision-2`) with `infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --existing --deployment decision-2` after updating the model version in the Bicep files.
2. Run `pnpm eval` against both deployments, on the synthetic fixtures and on exported labels (`pnpm --filter @clearbox/eval export-labels`). Compare delete precision, calibration and the option-order shuffle check.
3. Switch `AZURE_DECISION_DEPLOYMENT` with `pnpm setup:cf`. New suggestions carry the new `model_version`; the nightly calibration re-tunes `tau_delete` from new labels.
4. Delete the old deployment after the switch.

## 12. Roll back a deploy

Worker code is versioned; D1 is not rolled back with it.

```sh
$CF workers versions list --worker-id clearbox
$CF workers deployments create --worker clearbox --strategy percentage \
  --versions '[{"version_id":"<previous-version-id>","percentage":100}]'
```

If Cloudflare blocks the rollback because secrets changed since that version, add `--bypass-deployment-checks` only after checking that the old code works with the current secrets. Migrations are forward-only: never roll code back past a migration it does not understand. Fix forward with a new migration instead.

## 13. Schema changes

Add `app/migrations/000N_<name>.sql` (never edit an applied file), test it locally with `pnpm db:migrate:local`, then `pnpm setup:cf` (it applies pending migrations before deploying) or `$CF d1 migrations apply <d1-id> --dir app/migrations` followed by `pnpm deploy:cf`.

## 14. Locked out

- Access login works but Clearbox answers 403: `OWNER_EMAIL` differs from your Access identity, or `ACCESS_AUD` belongs to another application. Replace them with `pnpm setup:cf`.
- 500 `access_misconfigured` everywhere: a required secret is missing or malformed, `AZURE_DECISION_ENDPOINT` is not the https account root (no path, query, fragment or credentials), or `AZURE_DECISION_DEPLOYMENT` is `Microsoft-Decision-1` (`config.invalid` event lists names only).
- Cron jobs stopped: another Worker took the last Cron Trigger slot (5 per account on Free).

## 15. Checking tick CPU time after deploy

Workers Free allows 10 ms of CPU per cron invocation. Locally, `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-cpu.test.ts` guards the compute of one 25-message tick (pure stages under 8 ms). After a deploy, check the real numbers:

1. Cloudflare dashboard, Workers & Pages, `clearbox`, Observability, Query builder (Workers Logs must be enabled; `cloudflare.config.ts` enables invocation logs).
2. Filter invocation logs to the tick cron: `$metadata.message` equals `* * * * *` (cron invocations use the cron schedule as their message).
3. Visualize `$workers.cpuTimeMs` with P50, P99 and Max over the last 24 hours. P99 should stay well below 10; anything above 8 needs attention.
4. Find the slow ticks: filter `$workers.cpuTimeMs` greater than `8` and match them by time to the `tick.done` events (`evt = "tick.done"`), which carry `kind`, `fetched`, `decided` and `durationMs`.
5. Signs of CPU kills: `tick.claimed` without a matching `tick.done` or `tick.failed`, and accounts whose `page_size` dropped below 25 (each killed tick halves it on the next claim, minimum 5; successful ticks grow it back by 5). A low `page_size` is not always a CPU kill: a `tick.failed` with `errorCode` `subrequest_budget` (the tick ran out of its subrequest budget, 45 per tick on the Free tier) also halves it, without a backoff. Once `page_size` is at the floor of 5, a subrequest budget failure backs the account off like any other failure (`backoff_until`, growing `attempts`) instead of retrying every minute.

If ticks are being killed, the adaptive page size recovers on its own. If it stays low for days, lower the work per page (see the benchmark notes in `docs/superpowers/plans/2026-10-15-clearbox-04-scan-pipeline.md`, Task 12) or move to Workers Paid and set `FREE_TIER=false`.

## 16. Weekly reminder

On the weekday chosen on **Rules** (default Sunday, UTC), the nightly job (02:00 UTC) adds a plain text note from `Clearbox <reminder@clearbox.invalid>` to one connected inbox: the account whose address equals `OWNER_EMAIL`, else the oldest active, unpaused account. It is only added when something is waiting in Review, at most once in 7 days. Nothing is sent over email; Clearbox never sorts the note. Details: contracts 12.8.

- **Turn it off or change the day:** **Rules**, **Weekly reminder**, then **Save changes**.
- **Check it ran:** Workers Logs, `evt = "reminder.done"` (only logged on the reminder day). `outcome`: `sent`; `nothing_to_review` (Review was empty); `busy` (a tick held the mailbox lease through three attempts 15 s apart); `no_account` (no active, unpaused account); `not_configured` (secrets invalid); `no_budget`; `failed` with `errorCode` (for example `provider_auth`: reconnect the account; `provider_rate_limited`). A miss is retried the following week, not the next night.
- **Link missing in the note:** the link uses the origin recorded when you last opened Clearbox (`settings.app_origin`). Open Clearbox once after moving it to a new address.
- **First live check (Outlook):** the Graph note relies on the MAPI flag `PR_MESSAGE_FLAGS` to appear as received mail rather than a draft. After the first Outlook reminder, confirm it is in Inbox, unread and not shown as "This message hasn't been sent". If it shows as a draft, turn the reminder off and report it.
- **Never sorted:** the tick drops any message from `reminder@clearbox.invalid` before it is stored or sent to Decision-1, so the note never appears in Review. Delete or archive it in Gmail or Outlook as usual.
