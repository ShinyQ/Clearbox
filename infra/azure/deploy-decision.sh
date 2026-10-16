#!/usr/bin/env bash
# Deploys Microsoft-Decision-1 for Clearbox with the Bicep files in this directory.
# Runs `az deployment group what-if` first and asks before applying. Never prints API keys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCATION="swedencentral"
DEPLOYMENT_NAME="decision-1"
CAPACITY=300
ARM_DEPLOYMENT="clearbox-decision"
RESOURCE_GROUP=""
ACCOUNT=""
SUBSCRIPTION=""
EXISTING=false
CREATE_GROUP=false
ASSUME_YES=false
SMOKE_TEST=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> [options]

Creates an AIServices account in swedencentral (unless --existing) and a Microsoft-Decision-1
deployment (SKU DataZoneStandard, NoAutoUpgrade) for Clearbox.

Options:
  --existing            Only add the deployment to an existing AIServices account (decision-existing.bicep).
  --deployment <name>   Deployment name, sent as "model" by Clearbox. Default: decision-1.
  --capacity <rpm>      Requests per minute (1 capacity unit = 1 RPM). Default: 300.
  --subscription <id>   Run `az account set --subscription <id>` first.
  --create-group        Create the resource group in swedencentral when it does not exist (new account only).
  --yes                 Apply without asking after the what-if preview.
  --smoke-test          After deploying, send one synthetic request (the key is never printed).
  --dry-run             Print the az commands instead of running them.
  -h, --help            Show this help.
USAGE
}

die() {
  echo "deploy-decision: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --deployment) DEPLOYMENT_NAME="${2:-}"; shift 2 ;;
    --capacity) CAPACITY="${2:-}"; shift 2 ;;
    --subscription) SUBSCRIPTION="${2:-}"; shift 2 ;;
    --existing) EXISTING=true; shift ;;
    --create-group) CREATE_GROUP=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --smoke-test) SMOKE_TEST=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ -n "$RESOURCE_GROUP" ]] || die "--resource-group is required"
[[ -n "$ACCOUNT" ]] || die "--account is required"
[[ "$ACCOUNT" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || die "--account must be 2-64 lowercase letters, digits or '-'"
[[ "$DEPLOYMENT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || die "--deployment has invalid characters"
shopt -s nocasematch
[[ "$DEPLOYMENT_NAME" != "microsoft-decision-1" ]] || die "--deployment must not be Microsoft-Decision-1 (reserved word); use decision-1"
shopt -u nocasematch
if ! [[ "$CAPACITY" =~ ^[0-9]+$ ]] || ((CAPACITY < 1 || CAPACITY > 1000)); then
  die "--capacity must be 1-1000"
fi
if [[ "$EXISTING" == true && "$CREATE_GROUP" == true ]]; then
  die "--create-group cannot be combined with --existing"
fi

if [[ "$EXISTING" == true ]]; then
  TEMPLATE="$SCRIPT_DIR/decision-existing.bicep"
else
  TEMPLATE="$SCRIPT_DIR/decision.bicep"
fi
PARAMS=(--parameters "accountName=$ACCOUNT" "deploymentName=$DEPLOYMENT_NAME" "capacityRpm=$CAPACITY")

# Runs a command, or prints it in --dry-run mode.
run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Runs a command and prints its stdout, or prints the command and a placeholder in --dry-run mode.
capture() {
  if [[ "$DRY_RUN" == true ]]; then
    {
      printf '+'
      printf ' %q' "$@"
      printf '\n'
    } >&2
    echo "<dry-run>"
  else
    "$@"
  fi
}

if [[ "$DRY_RUN" != true ]]; then
  command -v az >/dev/null 2>&1 || die "Azure CLI (az) is not installed"
  az account show --output none 2>/dev/null || die "not logged in; run: az login"
fi
if [[ -n "$SUBSCRIPTION" ]]; then
  run az account set --subscription "$SUBSCRIPTION"
fi

echo "== Checking target"
if [[ "$EXISTING" == true ]]; then
  INFO="$(capture az cognitiveservices account show --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
    --query "[location, kind, properties.customSubDomainName, to_string(properties.disableLocalAuth)]" --output tsv)" \
    || die "account $ACCOUNT not found in resource group $RESOURCE_GROUP"
  if [[ "$DRY_RUN" != true ]]; then
    read -r ACCOUNT_LOCATION ACCOUNT_KIND ACCOUNT_SUBDOMAIN LOCAL_AUTH_DISABLED <<<"$(echo "$INFO" | tr '\n' ' ')"
    [[ "$ACCOUNT_LOCATION" == "$LOCATION" ]] || die "account is in $ACCOUNT_LOCATION; Clearbox needs $LOCATION (EU data zone)"
    [[ "$ACCOUNT_KIND" == "AIServices" ]] || die "account kind is $ACCOUNT_KIND; expected AIServices"
    [[ -n "$ACCOUNT_SUBDOMAIN" && "$ACCOUNT_SUBDOMAIN" != "None" ]] || die "account has no custom subdomain"
    [[ "$LOCAL_AUTH_DISABLED" != "true" ]] || die "account has local (key) auth disabled; Clearbox authenticates with api-key"
  fi
else
  if ! capture az group show --name "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
    [[ "$CREATE_GROUP" == true ]] || die "resource group $RESOURCE_GROUP not found (pass --create-group to create it)"
    run az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  fi
fi

echo "== Quota (AIServices.DataZoneStandard.Microsoft-Decision-1 in $LOCATION)"
QUOTA="$(capture az cognitiveservices usage list --location "$LOCATION" \
  --query "[?name.value=='AIServices.DataZoneStandard.Microsoft-Decision-1'] | [0].[limit, currentValue]" --output tsv || true)"
if [[ "$DRY_RUN" != true ]]; then
  read -r QUOTA_LIMIT QUOTA_USED <<<"$(echo "$QUOTA" | tr '\n' ' ')"
  if [[ -z "${QUOTA_LIMIT:-}" ]]; then
    echo "warning: no quota entry found; the model may not be offered to this subscription in $LOCATION" >&2
  else
    echo "limit ${QUOTA_LIMIT%.*} RPM, in use ${QUOTA_USED%.*} RPM, requested $CAPACITY RPM"
    if ((${QUOTA_LIMIT%.*} - ${QUOTA_USED%.*} < CAPACITY)); then
      echo "warning: requested capacity exceeds the free quota (fine when resizing this same deployment)" >&2
    fi
  fi
fi

echo "== What-if ($TEMPLATE)"
run az deployment group what-if --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --template-file "$TEMPLATE" "${PARAMS[@]}"

if [[ "$ASSUME_YES" != true && "$DRY_RUN" != true ]]; then
  read -r -p "Apply these changes? [y/N] " ANSWER
  [[ "$ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]] || die "cancelled"
fi

echo "== Deploying"
run az deployment group create --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --template-file "$TEMPLATE" "${PARAMS[@]}" --output none
ENDPOINT="$(capture az deployment group show --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --query properties.outputs.decisionEndpoint.value --output tsv)"

echo "== Verifying"
run az cognitiveservices account deployment show --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
  --deployment-name "$DEPLOYMENT_NAME" \
  --query "{state:properties.provisioningState, model:properties.model.name, version:properties.model.version, sku:sku.name, rpm:sku.capacity, upgrade:properties.versionUpgradeOption}" \
  --output table

if [[ "$SMOKE_TEST" == true ]]; then
  echo "== Smoke test (synthetic data)"
  if [[ "$DRY_RUN" == true ]]; then
    echo "+ curl POST $ENDPOINT/providers/microsoft/v1/systemone (key read into a variable, never printed)"
  else
    DECISION_KEY="$(az cognitiveservices account keys list --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
      --query key1 --output tsv)"
    BODY="{\"model\":\"$DEPLOYMENT_NAME\",\"state\":{\"email\":{\"from\":\"codes@login.example.com\",\"subject\":\"Your one-time code is 482913\",\"age_days\":12}},\"questions\":{\"action\":{\"type\":\"choice\",\"instructions\":\"What should the mailbox owner do with this email?\",\"criteria\":{\"delete\":\"No future value\",\"keep\":\"Needs attention\"}},\"is_expired\":{\"type\":\"noul\",\"instructions\":\"Has this time-bound content expired?\"}}}"
    RESPONSE="$(curl --silent --show-error --max-time 30 --write-out '\n%{http_code}' \
      --header @<(printf 'api-key: %s\n' "$DECISION_KEY") \
      --header 'content-type: application/json' \
      --data "$BODY" "$ENDPOINT/providers/microsoft/v1/systemone")"
    unset DECISION_KEY
    STATUS="${RESPONSE##*$'\n'}"
    echo "HTTP $STATUS"
    if [[ "$STATUS" == "200" ]]; then
      echo "${RESPONSE%$'\n'*}" | grep -o '"model":"[^"]*"' | head -n 1 || true
    else
      die "smoke test failed with HTTP $STATUS (see docs/runbook.md, Decision-1 outage)"
    fi
  fi
fi

cat <<EOF2

Done. Worker secrets (enter them when pnpm setup:cf asks):
  AZURE_DECISION_ENDPOINT   = $ENDPOINT
  AZURE_DECISION_DEPLOYMENT = $DEPLOYMENT_NAME
  AZURE_DECISION_KEY        = not printed. Copy it to the clipboard and paste it at the hidden prompt:
    az cognitiveservices account keys list --resource-group $RESOURCE_GROUP --name $ACCOUNT --query key1 --output tsv | pbcopy
    (Linux: replace pbcopy with: xclip -selection clipboard)
EOF2
