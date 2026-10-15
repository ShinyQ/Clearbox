# Research: Microsoft-Decision-1 (MAI-Decision-1) API for Clearbox

Researched 2026-10-15. Status: **docs plus third-party live captures; NOT live-verified by us.**

No Microsoft-Decision-1 deployment existed in the owner's subscription at research time (every AIServices account was scanned read-only with `az cognitiveservices account deployment list`), including the target account `<foundry-account>`, which had zero deployments. Creating one was out of scope, so no live calls were made. Response shapes below come from Microsoft Learn (request side), from a live response captured on 2026-10-09 and committed as a test fixture by the `everruns` project, and from the live notes of the `openai-scala-client` project (Sweden Central, 2026-10-09). Each fact is labelled with its source and evidence level:

- **[Learn]** official Microsoft documentation
- **[ARM]** read from Azure Resource Manager with `az` on 2026-10-15 (authoritative for this subscription)
- **[3P-live]** third-party code or docs that state they were verified against a live Foundry deployment
- **[3P-illustrative]** third-party example explicitly marked as not measured
- **[Ours]** measured locally by us (tokenizer only)

## 1. Sources

| Id | Source |
|---|---|
| S1 | [Learn: Deploy and use Microsoft-Decision-1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision) |
| S2 | [Launch blog (commandline.microsoft.com)](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/) |
| S3 | [Foundry catalog model card](https://ai.azure.com/catalog/models/Microsoft-Decision-1) |
| S4 | [everruns `crates/drivers/drivers/src/mai/decisions.rs`](https://github.com/everruns/everruns/blob/main/crates/drivers/drivers/src/mai/decisions.rs) (live response fixture, 2026-10-09) |
| S5 | [cequence-io/openai-scala-client `docs/decision-models.md`](https://github.com/cequence-io/openai-scala-client/blob/main/docs/decision-models.md), section "Microsoft-Decision-1 (Microsoft Foundry)" (live, Sweden Central, 2026-10-09) |
| S6 | [aiappsgbb/think-slow-act-fast `skills/think-slow-act-fast/decision-model.md`](https://github.com/aiappsgbb/think-slow-act-fast/blob/main/skills/think-slow-act-fast/decision-model.md) and [`starter/src/core/systemone.ts`](https://github.com/aiappsgbb/think-slow-act-fast/blob/main/starter/src/core/systemone.ts) (Microsoft GBB team) |
| S7 | [Lore-Hex/quill-router `docs/providers/microsoft-decision-1.md`](https://github.com/Lore-Hex/quill-router/blob/main/docs/providers/microsoft-decision-1.md) (live smoke, 2026-10-12) |
| S8 | [BerriAI/litellm `litellm/llms/azure_ai/decisions/transformation.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/azure_ai/decisions/transformation.py) |
| S9 | [OpenRouter models API, `output_modalities=decisions`](https://openrouter.ai/api/v1/models?output_modalities=decisions) (the model page `openrouter.ai/microsoft/microsoft-decision-1` returned 404 to our fetcher) |
| S10 | [Azure Retail Prices API filtered on "Decision"](https://prices.azure.com/api/retail/prices?$filter=contains(productName,'Decision')) |
| S11 | [Bicep reference: Microsoft.CognitiveServices accounts/deployments](https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/accounts/deployments?pivots=deployment-language-bicep) |
| S12 | `az cognitiveservices model list -l swedencentral`, `az cognitiveservices usage list -l swedencentral`, `az cognitiveservices account show`, `az provider show -n Microsoft.CognitiveServices` (run 2026-10-15) |
| S13 | [Qwen/Qwen3.5-9B tokenizer.json](https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/tokenizer.json) (base model per S2) |

## 2. Endpoint and authentication

| Item | Value | Evidence |
|---|---|---|
| Method and path | `POST {base}/providers/microsoft/v1/systemone` | [Learn] S1 |
| Base URL | Account root: `https://<account>.services.ai.azure.com`. Not a project URL (`.../api/projects/<p>` demands an undocumented `api-version`), not `/openai/v1`, not a deployment URL. | [3P-live] S4, S5, S6; S8 uses the same host |
| `https://<account>.cognitiveservices.azure.com` | Not tested by anyone we found. Use `services.ai.azure.com`. | unresolved |
| `api-version` query | Not needed | [3P-live] S5 |
| Auth (key) | `api-key: <key>` header | [Learn] S1, [3P-live] S4, S5 |
| Auth (Entra) | `Authorization: Bearer <token>`, scope `https://cognitiveservices.azure.com/.default`; caller needs a data-plane role such as Cognitive Services User | [Learn] S1, S6 |
| Project required? | No. The route is account-scoped. Learn lists a project as a portal prerequisite only. | [3P-live] S4, S6 |
| `model` field | The **deployment name**, not the catalog name. Sending `Microsoft-Decision-1` as model is a 404 `DeploymentNotFound`. | [Learn] S1, [3P-live] S5 |
| Deployment name | Must not be `Microsoft-Decision-1`: rejected with `ContainsReservedWord`. Use `decision-1`. | [3P-live] S5, S6 |
| Response `model` | Always `microsoft-decision-1` (underlying model), never the deployment name | [Learn] S1, [3P-live] S4, S7 |
| Unknown top-level request fields | Rejected with 400 `unrecognized_request_argument`. No `temperature`, `seed`, `stream`, `images`. | [3P-live] S5; S9 lists `supported_parameters: []` |
| Streaming, tools, images | Not supported; text-only | [Learn] S3, [3P-live] S5 |

## 3. Request

### 3.1 Question types (from S1)

| `type` | `instructions` | `criteria` |
|---|---|---|
| `choice` | required (string; S6 shows an object also works) | object `{ optionKey: description }`, 2 to 255 entries |
| `score` | required | array of level labels, lowest first, 2 to 10 entries |
| `noul` | required by Learn; S5 says Foundry accepts a noul without instructions | optional object `{ "true": "...", "false": "..." }` |

`state` may be a string or a JSON object [Learn]. Arrays are accepted by some hosts of the same protocol but are not documented by Microsoft; Clearbox should send an object.

### 3.2 Exact request example (Clearbox shape, synthetic data)

```json
{
  "model": "decision-1",
  "state": {
    "email": {
      "from": "deals@shop.example.com",
      "domain": "shop.example.com",
      "subject": "Last chance: 40% off all winter jackets ends tonight",
      "snippet": "Our biggest sale of the season ends at midnight. Free shipping on orders over $50.",
      "age_days": 41,
      "signals": { "has_list_unsubscribe": true, "precedence_bulk": true, "category": "promotions",
                   "is_read": false, "has_attachments": false, "owner_position": "to" }
    },
    "sender_history": { "messages_90d": 37, "open_rate": 0.0, "owner_delete_rate": 1.0, "is_correspondent": false },
    "similar_past_decisions": [ { "domain": "shop.example.com", "subject": "Flash sale: boots 30% off", "owner_action": "delete" } ]
  },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "What should the mailbox owner do with this email?",
      "criteria": {
        "keep": "Needs attention or is personally important to the owner",
        "delete": "No future value: promotions, expired notifications, ignored newsletters, superseded automated alerts",
        "unsure": "Cannot tell from the information given",
        "archive": "Worth keeping as a record but needs no attention: receipts, confirmations, completed threads"
      }
    },
    "importance": {
      "type": "score",
      "instructions": "How important is this email to the owner?",
      "criteria": ["Noise", "Low", "Moderate", "High", "Critical"]
    },
    "is_record": {
      "type": "noul",
      "instructions": "Is this a record the owner may need later (receipt, invoice, contract, statement, ticket, account notice)?"
    },
    "is_expired": {
      "type": "noul",
      "instructions": "Is the content time-bound, and has that time passed (one-time code, ended sale, past event)?"
    },
    "is_from_human": {
      "type": "noul",
      "instructions": "Was this written personally by a human to the owner, not generated by an automated system?"
    }
  }
}
```

(Option order of `action` is shuffled on purpose; see section 7.)

## 4. Response

### 4.1 Field-by-field

| Question type | Fields in `answers.<name>` | Evidence |
|---|---|---|
| `choice` | `type: "choice"`, `choice: string` (the selected key), `confidence: number`, `probabilities: { [optionKey]: number }` (one entry per offered option, sums to about 1) | [3P-live] S4; same names in S5, S6 |
| `score` | `type: "score"`, `score: number` (probability-weighted mean of level **indexes**, 0-based, may fall between levels), `confidence: number`, `legend: { "0": label, "1": label, ... }`, `probabilities: { "0": number, "1": number, ... }` keyed by **stringified index**, not by label | [3P-live] S4, S5; score semantics [Learn] S1 |
| `noul` | `type: "noul"`, `noul: number` (probability that the statement is true, 0 to 1). **No `probabilities`, no `confidence`.** | [3P-live] S4, S5 |
| top level | `model: "microsoft-decision-1"`, `answers: {...}`, `usage: { input_tokens: number, output_tokens: number }` | [3P-live] S4, S5, S7 |

Notes:

- There is **no `id`** field in any captured response. The request id is in the `apim-request-id` response header (an `x-request-id` header is also returned) [3P-live] S5.
- Usage field names are `input_tokens` / `output_tokens`, **not** `prompt_tokens` / `completion_tokens` [3P-live] S4, S5, S7. `output_tokens` is about 1 per question (3 for 3 questions in S4 and S7) and is free.
- `confidence` semantics are undocumented. In the S4 capture, choice `confidence` (0.99839) equals top probability minus second probability (0.99920 - 0.00080), while score `confidence` (0.388) does not match that rule. Do not depend on `confidence`; compute what Clearbox needs from `probabilities`.
- S5 mentions a `Refusal` answer kind for the same protocol on other hosts ("a question the model declines"). Not observed on Foundry, but the validator must tolerate an unknown answer `type` and map it to `unsure`.

### 4.2 Response example from a live call (third party, NOT captured by us)

Verbatim from S4 (`live_response()`, "The live response from 2026-10-09, trimmed to one answer per primitive"; state was "My payment failed twice today."):

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "priority": {
      "type": "score",
      "score": 1.591248736299162,
      "confidence": 0.3882084721160395,
      "legend": { "0": "Routine", "1": "Important", "2": "Urgent" },
      "probabilities": { "0": 0.0008902451115308707, "1": 0.4069707734777761, "2": 0.592138981410693 }
    },
    "team": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.9983918284983826,
      "probabilities": { "billing": 0.9991959142491913, "technical": 0.0008040857508087322 }
    },
    "urgency": { "type": "noul", "noul": 0.9971990694457676 }
  },
  "usage": { "input_tokens": 115, "output_tokens": 3 }
}
```

### 4.3 Expected Clearbox response (constructed from 4.1, illustrative values)

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "action": { "type": "choice", "choice": "delete", "confidence": 0.93,
                "probabilities": { "keep": 0.01, "delete": 0.95, "unsure": 0.02, "archive": 0.02 } },
    "importance": { "type": "score", "score": 0.21, "confidence": 0.7,
                    "legend": { "0": "Noise", "1": "Low", "2": "Moderate", "3": "High", "4": "Critical" },
                    "probabilities": { "0": 0.81, "1": 0.17, "2": 0.02, "3": 0.0, "4": 0.0 } },
    "is_record": { "type": "noul", "noul": 0.03 },
    "is_expired": { "type": "noul", "noul": 0.91 },
    "is_from_human": { "type": "noul", "noul": 0.01 }
  },
  "usage": { "input_tokens": 520, "output_tokens": 5 }
}
```

### 4.4 TypeScript interfaces

```ts
export interface DecisionChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface DecisionScoreAnswer {
  type: 'score';
  /** Probability-weighted mean of 0-based level indexes. */
  score: number;
  confidence: number;
  /** Keys are stringified indexes: "0", "1", ... */
  legend: Record<string, string>;
  /** Keys are stringified indexes: "0", "1", ... */
  probabilities: Record<string, number>;
}

export interface DecisionNoulAnswer {
  type: 'noul';
  /** P(true), 0..1 */
  noul: number;
}

export type DecisionAnswer = DecisionChoiceAnswer | DecisionScoreAnswer | DecisionNoulAnswer;

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Azure gateway errors (400, 401, 403, 404, 413, 429). */
export interface AzureErrorBody {
  error: { code?: string; message?: string; details?: unknown };
}

/** Backend validation errors (422). */
export interface BackendErrorBody {
  detail: string | unknown;
}
```

### 4.5 zod schema (validate exactly what Clearbox asked for)

```ts
import { z } from 'zod';

const prob = z.number().finite().min(0).max(1);
const ACTIONS = ['delete', 'archive', 'keep', 'unsure'] as const;
const LEVELS = ['0', '1', '2', '3', '4'] as const;

const sumsToOne = (r: Record<string, number>) =>
  Math.abs(Object.values(r).reduce((s, p) => s + p, 0) - 1) <= 0.01;

const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.enum(ACTIONS),
  confidence: prob.optional(),
  probabilities: z.object({
    delete: prob, archive: prob, keep: prob, unsure: prob,
  }).strict().refine(sumsToOne, 'choice probabilities must sum to 1'),
}).passthrough();

const ScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number().finite().min(0).max(LEVELS.length - 1),
  confidence: prob.optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.enum(LEVELS), prob).optional(),
}).passthrough();

const NoulAnswer = z.object({
  type: z.literal('noul'),
  noul: prob,
}).passthrough();

export const ClearboxDecisionResponse = z.object({
  model: z.string().min(1),
  answers: z.object({
    action: ChoiceAnswer,
    importance: ScoreAnswer,
    is_record: NoulAnswer,
    is_expired: NoulAnswer,
    is_from_human: NoulAnswer,
  }).passthrough(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

export type ClearboxDecisionResponse = z.infer<typeof ClearboxDecisionResponse>;
```

Design choices: `.passthrough()` everywhere so additive preview changes do not fail validation; `confidence`, `legend` and score `probabilities` optional because Clearbox does not depend on them; the choice probability set must be exactly the four offered keys. Any failure maps to `unsure` (spec section 10).

## 5. Errors and headers

| HTTP | Body shape | Cause | Evidence |
|---|---|---|---|
| 400 | `{"error":{"code":"unrecognized_request_argument" \| "unsupported_request_argument" \| ...,"message":"...","details":...}}` | invalid question type/shape; unknown top-level field; choice with 1 option; score with 1 or more than 10 levels | [Learn] S1 status, [3P-live] S5 body |
| 401 | `{"error":{"code","message"}}` | missing/invalid key or token | [Learn] S1, [3P-live] S5 |
| 403 | Azure error envelope (assumed) | identity lacks access | [Learn] S1 |
| 404 | `{"error":{"code":"DeploymentNotFound","message":"The API deployment x does not exist."}}` | wrong `model` (deployment name) or wrong path | [3P-live] S4, S5 |
| 413 | not captured | body larger than 1 MiB | [3P-live] S5 |
| 422 | `{"detail":"invalid TypeSafe request: ..."}` | more than 255 questions; state plus questions over the token limit; Learn also lists "deployment name or question definition isn't supported" | [Learn] S1, [3P-live] S5 |
| 429 | not captured; assume the Azure envelope | deployment rate limit exceeded | [Learn] S1 |
| 5xx | not captured | | |

Headers:

| Header | Status |
|---|---|
| `apim-request-id`, `x-request-id` | present [3P-live] S5. Log `apim-request-id` (opaque, safe) for support cases. |
| `x-ratelimit-limit-requests` | present, equals the deployment RPM [3P-live] S5 |
| `x-ratelimit-remaining-requests`, `retry-after`, `retry-after-ms` | **not verified**. They are standard on other Foundry/Azure OpenAI deployments. Treat as optional: honor `retry-after-ms` then `retry-after` when present, else exponential backoff with jitter. |

Client rules: parse the body as JSON if possible, read `error.code` or `detail`, never log the body (it can echo request text). Retry only 408, 429, 500, 502, 503, 504 and network timeouts. Never retry 400, 401, 403, 404, 413, 422.

## 6. Limits

| Limit | Value | Evidence |
|---|---|---|
| Rate unit | **1 capacity unit = 1 request per minute.** ARM `rateLimits: [{count: 1, renewalPeriod: 60}]` per unit. Not tokens-per-minute. | [ARM] S12, S6 |
| Default capacity offered in catalog | 500 RPM (ARM `capacity.default: 500`, `maximum: 1000000`) | [ARM] S12 |
| Subscription quota, swedencentral, `AIServices.DataZoneStandard.Microsoft-Decision-1` | limit **500**, current **0** (owner subscription, 2026-10-15). Shared by every deployment of this model in this subscription and region. | [ARM] S12 |
| Observed per-deployment limit | 50 RPM on a third-party deployment (their capacity choice); 58 back-to-back calls produced no 429 | [3P-live] S5 |
| Enforcement window | Unknown (Azure OpenAI uses sub-minute windows, so bursts above capacity/60 per second may 429 early) | unresolved |
| Context window | 32,768 tokens (model card per S7, OpenRouter S9); Foundry host enforced 64,000 for state plus questions in S5 | S7, S9, [3P-live] S5 |
| Questions per request | 255 (256 is a 422) | [3P-live] S5 |
| Options per `choice` | 2 to 255 | [3P-live] S4, S5 |
| Levels per `score` | 2 to 10 | [3P-live] S4, S5 |
| Body size | under 1 MiB (413 otherwise) | [3P-live] S5 |
| Latency | p50 about 0.25 to 0.35 s for 1 to 40 questions from Europe; 30k-token state in about 0.9 s | [3P-live] S5 |
| Model version retirement | inference retirement **2027-02-04T00:00:00Z** for version 1 | [ARM] S12 |
| `maxCapacity: 3` in model list | meaning undocumented (possibly max deployments per account) | [ARM] S12, unresolved |

## 7. Tokens, determinism, option order

### 7.1 Token counting

- Base model is Qwen3.5-9B [S2], so the Qwen3.5 tokenizer is the right estimator [S13].
- **Questions and criteria count as input tokens.** The host bills the state once plus a per-question overhead: about 20 to 35 input tokens per extra short question (1 question: 49 tokens, 40 questions: 1,325 tokens on the same state) [3P-live] S5.
- Measured with the Qwen3.5-9B tokenizer on the section 3.2 request with synthetic values [Ours]:

| Text | Chars | Tokens | Chars per token |
|---|---:|---:|---:|
| State, compact JSON, 5 past decisions | 1,086 | 274 | 3.96 |
| State, pretty-printed JSON (indent 2) | 1,391 | 446 | 3.12 |
| State, compact JSON, 1 past decision | 718 | 182 | 3.95 |
| Clearbox `questions` object, compact | 1,016 | 216 | 4.70 |
| English prose (snippet only) | 203 | 45 | 4.51 |

- Heuristic for the budget: **3.5 characters per token for compact JSON state** (conservative), 4.5 for English prose. Always send compact JSON (`JSON.stringify(state)` with no indent); pretty-printing costs about 60% more tokens.
- Expected billed input per Clearbox request: about 200 to 300 tokens for the five questions (fixed) plus 180 to 400 for the state, so **about 450 to 700 tokens**. Treat `usage.input_tokens` as the truth and record it.

### 7.2 Determinism

- No sampling or decoding parameters exist (no `temperature`, `seed`, `top_p`); unknown fields are rejected [3P-live] S5, S9 (`supported_parameters: []`). S5: "System One does not sample".
- The model is a single-pass scorer that returns probabilities [S2]. Identical input should give the same probabilities up to floating-point noise from batched GPU inference. Not verified by us; tests must not assert exact floats.
- `choice` returns the argmax; Clearbox recomputes from `probabilities` anyway.

### 7.3 Option order and wording

- Learn: "Scores can change based on how you phrase or order questions and options ... Consider randomizing option order" [Learn] S1.
- Blog: 1.3% average decision flips across 8 perturbations, "zero flips when option descriptions are paraphrased or when options are reversed or shuffled" [S2].
- Microsoft GBB starter shuffles options on every call to counter first-option bias [S6].
- Recommendation: shuffle the `action` criteria order per request with a seeded RNG (seed from message id, so a retry is reproducible); keep keys stable; keep `score` levels in ascending order (order is semantic); include the abstain option (`unsure`), as Learn recommends.

## 8. Pricing

| Item | Value | Evidence |
|---|---|---|
| Input | **$0.042 per 1M tokens** | S2, S10 (meter `Microsoft Decision 1 1M Tokens`, effective 2026-10-01) |
| Output | free (no output meter exists) | S2, S10 |
| DataZoneStandard vs GlobalStandard | Same single meter, same price in every listed region including `swedencentral` | S10, S5 ("$0.042 per 1M input tokens in the US and EU data zones") |
| Clearbox estimate | 600 tokens x $0.042/M = $0.0000252 per email, about **$0.25 per 10k emails** (spec's 800-token figure gives $0.34) | derived |

## 9. Deployment IaC (generic)

### 9.1 az CLI

```bash
RG=<resource-group>
ACCOUNT=<globally-unique-name>
LOCATION=swedencentral

az cognitiveservices account create \
  --name "$ACCOUNT" --resource-group "$RG" --location "$LOCATION" \
  --kind AIServices --sku S0 \
  --custom-domain "$ACCOUNT" \
  --assign-identity --yes

az cognitiveservices account deployment create \
  --name "$ACCOUNT" --resource-group "$RG" \
  --deployment-name decision-1 \
  --model-name Microsoft-Decision-1 --model-format Microsoft --model-version 1 \
  --sku-name DataZoneStandard --sku-capacity 300
```

`--sku-capacity` is RPM (section 6). The Learn example's `--sku-capacity 1` would mean **1 request per minute**, which is unusable for Clearbox.

### 9.2 Bicep

Compiled successfully with `az bicep build` on 2026-10-15. API version `2026-07-01` is the newest GA version on the Learn reference page (S11); ARM also lists `2026-09-01` GA for `accounts` (S12), which can be adopted once Learn documents it.

```bicep
@description('Azure region. Must offer Microsoft-Decision-1 with the chosen SKU (DataZoneStandard in swedencentral).')
param location string = 'swedencentral'

@description('Globally unique AIServices account name; also used as the custom subdomain.')
param accountName string

@description('Deployment name sent as "model" in requests. Must NOT be "Microsoft-Decision-1" (reserved word).')
param deploymentName string = 'decision-1'

@description('Requests per minute (1 capacity unit = 1 RPM for this model).')
@minValue(1)
param capacityRpm int = 300

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    allowProjectManagement: true
  }
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'DataZoneStandard'
    capacity: capacityRpm
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1'
      version: '1'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output decisionBaseUrl string = 'https://${accountName}.services.ai.azure.com'
output deploymentName string = decision.name
```

`disableLocalAuth: false` is required because the Cloudflare Worker authenticates with `api-key` (it has no Entra managed identity). `NoAutoUpgrade` keeps behavior stable for calibration; plan a manual move before 2027-02-04.

## 10. Target environment (generic)

The owner's concrete subscription, resource group and account names were located read-only on 2026-10-15 and are kept outside this public repo. Facts that matter for Clearbox:

| Field | Value |
|---|---|
| Subscription | `<subscription>` |
| Resource group | `<resource-group>` |
| AIServices account | `<foundry-account>` (kind `AIServices`, SKU `S0`), with a default Foundry project |
| Region | **swedencentral** (DataZoneStandard EU is available here; model `capabilities.area: EUR`) |
| Decision endpoint base (use this) | `https://<foundry-account>.services.ai.azure.com` |
| Full Decision URL | `https://<foundry-account>.services.ai.azure.com/providers/microsoft/v1/systemone` |
| Local auth (keys) | enabled (`disableLocalAuth: false`) |
| Public network access | Enabled |
| Existing deployments | none at research time |
| Quota available | 500 of 500 RPM (`AIServices.DataZoneStandard.Microsoft-Decision-1`, swedencentral, subscription-wide) |

The account is already in swedencentral, so only the deployment must be created.

### 10.1 Commands to run later (during implementation, not now)

```bash
SUB=<subscription>
RG=<resource-group>
ACCOUNT=<foundry-account>
az account set --subscription "$SUB"

# 1. Confirm quota is still free (expect limit 500, currentValue < 500)
az cognitiveservices usage list -l swedencentral \
  --query "[?name.value=='AIServices.DataZoneStandard.Microsoft-Decision-1']" -o table

# 2. Create the deployment (capacity = requests per minute)
az cognitiveservices account deployment create \
  --resource-group "$RG" \
  --name "$ACCOUNT" \
  --deployment-name decision-1 \
  --model-name Microsoft-Decision-1 \
  --model-format Microsoft \
  --model-version 1 \
  --sku-name DataZoneStandard \
  --sku-capacity 300

# 3. Pin the version (the CLI does not expose versionUpgradeOption on create in all versions)
az resource update \
  --ids "$(az cognitiveservices account deployment show -g "$RG" -n "$ACCOUNT" \
           --deployment-name decision-1 --query id -o tsv)" \
  --set properties.versionUpgradeOption=NoAutoUpgrade

# 4. Verify
az cognitiveservices account deployment show -g "$RG" -n "$ACCOUNT" \
  --deployment-name decision-1 \
  --query "{state:properties.provisioningState,model:properties.model,sku:sku}" -o json

# 5. Worker secrets (never echo the key):
#    AZURE_DECISION_ENDPOINT   = https://<foundry-account>.services.ai.azure.com
#    AZURE_DECISION_DEPLOYMENT = decision-1
#    AZURE_DECISION_KEY        = output of: az cognitiveservices account keys list -g "$RG" -n "$ACCOUNT" --query key1 -o tsv
#    Set them with `pnpm setup:cf` (cf deploy --secrets-file) or `npx wrangler secret put <NAME> --name clearbox`.

# 6. Smoke test (synthetic data; key read from env, never printed)
curl -sS -D - "https://$ACCOUNT.services.ai.azure.com/providers/microsoft/v1/systemone" \
  -H "Content-Type: application/json" -H "api-key: $AZURE_DECISION_KEY" \
  -d '{"model":"decision-1","state":"Your one-time code is 123456. It expires in 10 minutes.","questions":{
        "action":{"type":"choice","instructions":"What should the owner do?","criteria":{"delete":"No future value","keep":"Needs attention"}},
        "importance":{"type":"score","instructions":"How important?","criteria":["Low","Medium","High"]},
        "is_expired":{"type":"noul","instructions":"Has this time-bound content expired?"}}}'
```

After step 6, update this document with the captured headers (especially `x-ratelimit-*`, `retry-after`) and a real response, and add a 429 capture if one can be provoked cheaply.

Bicep alternative for an existing account (deployment only):

```bicep
param accountName string

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: accountName
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: 'decision-1'
  sku: { name: 'DataZoneStandard', capacity: 300 }
  properties: {
    model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}
```

Deploy with `az deployment group create -g <resource-group> --template-file infra/azure/decision-existing.bicep --parameters accountName=<foundry-account>`.

## 11. Implications for Clearbox / spec corrections

1. **Section 3, Response row:** replace "the selected option and a probability per option" with the per-type shape: `choice` gives `choice` + `probabilities` per key (+ `confidence`); `score` gives `score` (0-based index mean) + `legend` + `probabilities` keyed `"0".."4"`; `noul` gives a single `noul` number. Usage is `usage.input_tokens` / `usage.output_tokens`. Add retirement date 2027-02-04 for version 1.
2. **Section 3, Endpoint:** pin the base to the account root `https://<foundry-account>.services.ai.azure.com`, not a project URL. No `api-version`.
3. **Deployment name:** must not be `Microsoft-Decision-1` (reserved). Use `decision-1` for `AZURE_DECISION_DEPLOYMENT`; section 12 should say "a deployment named `decision-1` of model `Microsoft-Decision-1`".
4. **Capacity is RPM.** Capacity 1 = 1 request per minute. Use 300 (quota 500 available in swedencentral). Section 9 "25 requests, at most 6 concurrent" can burst far above that (6 concurrent at about 0.3 s is about 1,200 RPM). Add a per-deployment rate limiter (for example at most 5 requests per second for 300 RPM) and treat 429 as a step retry honoring `retry-after-ms` / `retry-after` if present. Make capacity a setting (`DECISION_RPM`) shared by all accounts.
5. **Section 6.3 token budget:** questions are billed too (about 200 to 300 tokens for the five Clearbox questions). Redefine the 800-token target as total `input_tokens`, which leaves about 500 tokens for compact-JSON state (about 1,750 characters at 3.5 chars/token). Send compact JSON. Record `usage.input_tokens` per call in `budget`.
6. **Section 6.3 option order:** shuffle `action` option order per request (seeded by message id); keep `score` levels ascending.
7. **Section 6.4 Fusion:** `m` comes from `answers.action.probabilities`; flags come from `answers.<flag>.noul`; `importance` from `answers.importance.score` (range 0 to 4, not 1 to 5). Do not use `confidence`.
8. **Section 8:** `suggestions.model_version` should store the response `model` (`microsoft-decision-1`) plus the deployment name and version (`decision-1@1`), because the response does not echo the deployment.
9. **Section 10:** do not retry 400/404/413/422 (deterministic failures); retry 408/429/5xx/timeouts only. Log `apim-request-id`, never the body. Unknown answer `type` (for example a refusal) maps to `unsure`.
10. **Request hygiene:** do not send any extra top-level field (rejected with 400). No temperature or seed exist; tests must not assert exact probabilities.
11. **Section 7, Data residency:** confirmed `DataZoneStandard` in swedencentral is area `EUR`. Pricing is identical to GlobalStandard.
12. **Section 9 cost:** $0.042/M input confirmed, output free; expect about $0.25 to $0.34 per 10k emails.
13. **Context limit** is not a concern (32k model card; Clearbox uses under 1k).

## 12. Unresolved questions

1. Exact 429 body and whether `retry-after` / `retry-after-ms` / `x-ratelimit-remaining-requests` are sent (only `x-ratelimit-limit-requests` is confirmed).
2. Rate-limit window granularity (per minute vs per 10 s).
3. Whether `https://<account>.cognitiveservices.azure.com/providers/microsoft/v1/systemone` also works (use `services.ai.azure.com` regardless).
4. Semantics of `confidence`, especially for `score`.
5. Exact determinism across identical calls (expected stable up to float noise).
6. Exact billed overhead per question for Clearbox's longer criteria (estimate 200 to 300 tokens total; measure on first live call).
7. Context window: 32,768 (catalog/OpenRouter) vs 64,000 observed on Foundry. Irrelevant at Clearbox sizes.
8. Meaning of `maxCapacity: 3` in the model list.
9. Whether 5xx bodies follow the Azure `error` envelope.
