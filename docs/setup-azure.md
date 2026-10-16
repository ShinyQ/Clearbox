# Set up Azure (Microsoft-Decision-1)

Clearbox scores each email with **Microsoft-Decision-1** on Microsoft Foundry, in **Sweden Central** with the **DataZoneStandard** SKU (EU data zone). You need:

- an AIServices (Foundry) account in `swedencentral` with a custom subdomain and key auth enabled;
- a deployment named `decision-1` of model `Microsoft-Decision-1` (format `Microsoft`, version `1`), capacity **300** (for this model one capacity unit is one request per minute), version upgrades off (`NoAutoUpgrade`).

Cost: $0.042 per 1M input tokens, output is free. Clearbox sends about 450 to 800 input tokens per email, about $0.19 to $0.34 per 10,000 emails. Version 1 retires on **2027-02-04** (see [runbook.md](runbook.md)).

## 1. Prerequisites

```sh
az login
az account set --subscription "<subscription>"
az bicep install            # or: az bicep upgrade
```

You need Contributor (or Cognitive Services Contributor) on the resource group. Check the regional quota (expect `limit` 500 or more and room for 300):

```sh
az cognitiveservices usage list --location swedencentral \
  --query "[?name.value=='AIServices.DataZoneStandard.Microsoft-Decision-1']" --output table
```

## 2. Deploy with the script

The script previews the change with `az deployment group what-if`, asks before applying, verifies the deployment and never prints the key. Add `--dry-run` to only print the commands.

New account (the name must be globally unique, lowercase letters, digits and `-`; it becomes `https://<foundry-account>.services.ai.azure.com`):

```sh
infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --create-group --smoke-test
```

Existing AIServices account (only adds the deployment; checks region, kind, subdomain and key auth first; the name may contain uppercase letters and `_`):

```sh
infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --existing --smoke-test
```

Options: `--deployment <name>` (default `decision-1`), `--capacity <rpm>` (default 300), `--subscription <id>`, `--create-group` (new account only), `--yes` (no confirmation), `--smoke-test` (one synthetic request after deploying), `--dry-run`.

The script ends with the values for the Worker secrets:

| Secret                      | Value                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `AZURE_DECISION_ENDPOINT`   | `https://<foundry-account>.services.ai.azure.com`                                          |
| `AZURE_DECISION_DEPLOYMENT` | `decision-1`                                                                               |
| `AZURE_DECISION_KEY`        | not printed; copy it to the clipboard and paste it at the hidden prompt of `pnpm setup:cf` |

```sh
az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key1 --output tsv | pbcopy
```

(Linux: pipe to `xclip -selection clipboard` instead of `pbcopy`.)

## 3. Bicep directly

```sh
az deployment group what-if --resource-group <resource-group> --name clearbox-decision \
  --template-file infra/azure/decision.bicep --parameters accountName=<foundry-account>
az deployment group create --resource-group <resource-group> --name clearbox-decision \
  --template-file infra/azure/decision.bicep --parameters accountName=<foundry-account>
```

Use `infra/azure/decision-existing.bicep` for an existing account. Parameters: `accountName` (required), `deploymentName` (default `decision-1`), `capacityRpm` (default 300). `decision.bicep` only allows `swedencentral`.

Do not point `decision.bicep` at an account you created by other means: it would reset that account's network and auth settings. Use the existing-account template.

## 4. Plain az commands (no Bicep)

```sh
az cognitiveservices account create --name <foundry-account> --resource-group <resource-group> \
  --location swedencentral --kind AIServices --sku S0 --custom-domain <foundry-account> --assign-identity --yes

az cognitiveservices account deployment create --name <foundry-account> --resource-group <resource-group> \
  --deployment-name decision-1 --model-name Microsoft-Decision-1 --model-format Microsoft --model-version 1 \
  --sku-name DataZoneStandard --sku-capacity 300

az resource update --set properties.versionUpgradeOption=NoAutoUpgrade --ids "$(az cognitiveservices account deployment show \
  --resource-group <resource-group> --name <foundry-account> --deployment-name decision-1 --query id --output tsv)"
```

`--sku-capacity 1` (as in some examples) would mean one request per minute: unusable.

## 5. Run the model evaluation

The eval harness calls the real deployment with synthetic emails (`eval/fixtures/emails.jsonl`). It never runs in CI. The key goes into the environment of your shell only, never into a file:

```sh
export AZURE_DECISION_ENDPOINT="https://<foundry-account>.services.ai.azure.com"
export AZURE_DECISION_DEPLOYMENT="decision-1"
export AZURE_DECISION_KEY="$(az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key1 --output tsv)"
pnpm eval
unset AZURE_DECISION_KEY
```

The report is written under `eval/private/reports/` (git-ignored). The command exits with code 2 when the evaluation finds a harmful delete.

To also measure against your own decisions, export your labels (message subjects and snippets of the last 30 days, so keep the output private; it is written only under the git-ignored `eval/private/`) and point the eval at the file:

```sh
pnpm --filter @clearbox/eval export-labels            # from the remote D1 database
pnpm --filter @clearbox/eval export-labels --local    # from the local development database
pnpm eval --fixtures "$PWD/eval/private/owner-labels.jsonl"
```

The remote export reads the database id from `app/clearbox.local.json` or `CLEARBOX_D1_ID`, and needs the `cf` login from [setup-cloudflare.md](setup-cloudflare.md).

## 6. Troubleshooting

| Error                                 | Meaning and fix                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ContainsReservedWord` at deploy time | The deployment cannot be named `Microsoft-Decision-1`. Use `decision-1`.                                                     |
| `InsufficientQuota`                   | Lower `--capacity` or request quota for `AIServices.DataZoneStandard.Microsoft-Decision-1` in swedencentral.                 |
| 401 from the API                      | Wrong or rotated key. Update `AZURE_DECISION_KEY` with `pnpm setup:cf`.                                                      |
| 404 `DeploymentNotFound`              | `AZURE_DECISION_DEPLOYMENT` must be the deployment name, and the endpoint must be the account root.                          |
| 400 `unrecognized_request_argument`   | A request carried an extra top-level field. Clearbox sends only `model`, `state` and `questions`; check for a modified client. |
| 429                                   | More than the deployment capacity per minute. Clearbox retries on later ticks; raise `--capacity` if it persists.            |
