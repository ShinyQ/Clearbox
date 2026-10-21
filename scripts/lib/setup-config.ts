import { isValidKey } from "../gen-key.ts";

export const WORKER_NAME = "clearbox";
export const D1_NAME = "clearbox";
export const MIN_NODE_VERSION = "24.22.1";
export const MIN_PNPM_VERSION = "12.0.0";
export const LOCAL_CONFIG_PATH = "app/clearbox.local.json";
export const SECRETS_FILE_PATH = "app/deploy.secrets.json";
export const MIGRATIONS_DIR = "app/migrations";
export const FIRST_MIGRATION_PATH = "app/migrations/0001_init.sql";
export const CF_BIN_PATH = "app/node_modules/.bin/cf";

export class SetupError extends Error {
  override name = "SetupError";
}

export const SECRET_NAMES = [
  "AZURE_DECISION_ENDPOINT",
  "AZURE_DECISION_KEY",
  "AZURE_DECISION_DEPLOYMENT",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "TOKEN_ENC_KEY",
  "STATE_SIGNING_KEY",
  "OWNER_EMAIL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretValues = Partial<Record<SecretName, string>>;

export interface SecretSpec {
  name: SecretName;
  source: "generated" | "prompt";
  hidden: boolean;
  label: string;
  help: string;
  defaultValue: string | null;
  allowEmpty: boolean;
  normalize: (raw: string) => string;
  /** Error message, or null when valid. Never called with "". */
  validate: (value: string) => string | null;
}

const trim = (raw: string): string => raw.trim();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

export function validateEndpoint(value: string): string | null {
  return /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.services\.ai\.azure\.com$/.test(value)
    ? null
    : "Use the Foundry account root, for example https://<foundry-account>.services.ai.azure.com (no path, no trailing slash).";
}

export function validateDeploymentName(value: string): string | null {
  if (value.toLowerCase() === "microsoft-decision-1") {
    return "Use the deployment name (for example decision-1), not the model name Microsoft-Decision-1.";
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? null
    : "Deployment names use letters, digits, '.', '_' and '-'.";
}

export function normalizeTeamDomain(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/\/+$/, "");
  if (value === "") return "";
  if (!value.includes("://"))
    value = `https://${value.includes(".") ? value : `${value}.cloudflareaccess.com`}`;
  return value;
}

export function validateTeamDomain(value: string): string | null {
  return /^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(value)
    ? null
    : "Use your Zero Trust team domain, for example https://<team>.cloudflareaccess.com.";
}

export const SECRET_SPECS: readonly SecretSpec[] = [
  {
    name: "AZURE_DECISION_ENDPOINT",
    source: "prompt",
    hidden: false,
    label: "AZURE_DECISION_ENDPOINT",
    help: "Decision-1 base URL printed by infra/azure/deploy-decision.sh (account root).",
    defaultValue: null,
    allowEmpty: false,
    normalize: normalizeEndpoint,
    validate: validateEndpoint,
  },
  {
    name: "AZURE_DECISION_KEY",
    source: "prompt",
    hidden: true,
    label: "AZURE_DECISION_KEY",
    help: "Foundry account key (key1). See docs/setup-azure.md for how to copy it without printing it.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) =>
      /^\S{16,}$/.test(v) ? null : "Paste the full key1 or key2 value of the Foundry account.",
  },
  {
    name: "AZURE_DECISION_DEPLOYMENT",
    source: "prompt",
    hidden: false,
    label: "AZURE_DECISION_DEPLOYMENT",
    help: "Name of the Microsoft-Decision-1 deployment (not the model name).",
    defaultValue: "decision-1",
    allowEmpty: false,
    normalize: trim,
    validate: validateDeploymentName,
  },
  {
    name: "GOOGLE_CLIENT_ID",
    source: "prompt",
    hidden: false,
    label: "GOOGLE_CLIENT_ID",
    help: "Google OAuth web client id (docs/setup-google.md). Leave empty to disable Gmail.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) =>
      /^[\w-]+\.apps\.googleusercontent\.com$/.test(v) ? null : "Expected <id>.apps.googleusercontent.com.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    source: "prompt",
    hidden: true,
    label: "GOOGLE_CLIENT_SECRET",
    help: "Google OAuth client secret. Leave empty only when GOOGLE_CLIENT_ID is empty.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) => (/^\S{10,}$/.test(v) ? null : "Paste the full client secret."),
  },
  {
    name: "MS_CLIENT_ID",
    source: "prompt",
    hidden: false,
    label: "MS_CLIENT_ID",
    help: "Entra application (client) ID (docs/setup-microsoft.md). Leave empty to disable Outlook.",
    defaultValue: null,
    allowEmpty: true,
    normalize: (raw) => raw.trim().toLowerCase(),
    validate: (v) => (GUID.test(v) ? null : "Expected a GUID such as 00000000-0000-0000-0000-000000000000."),
  },
  {
    name: "MS_CLIENT_SECRET",
    source: "prompt",
    hidden: true,
    label: "MS_CLIENT_SECRET",
    help: "Entra client secret VALUE (not the secret ID). Leave empty only when MS_CLIENT_ID is empty.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) => (/^\S{10,}$/.test(v) ? null : "Paste the full client secret value."),
  },
  {
    name: "TOKEN_ENC_KEY",
    source: "generated",
    hidden: true,
    label: "TOKEN_ENC_KEY",
    help: "AES-256-GCM key for OAuth tokens.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) => (isValidKey(v) ? null : "Expected base64 of 32 bytes."),
  },
  {
    name: "STATE_SIGNING_KEY",
    source: "generated",
    hidden: true,
    label: "STATE_SIGNING_KEY",
    help: "HMAC-SHA-256 key for the OAuth state cookie.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) => (isValidKey(v) ? null : "Expected base64 of 32 bytes."),
  },
  {
    name: "OWNER_EMAIL",
    source: "prompt",
    hidden: false,
    label: "OWNER_EMAIL",
    help: "The only email allowed to use this deployment (must match your Access login).",
    defaultValue: null,
    allowEmpty: false,
    normalize: (raw) => raw.trim().toLowerCase(),
    validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address."),
  },
  {
    name: "ACCESS_TEAM_DOMAIN",
    source: "prompt",
    hidden: false,
    label: "ACCESS_TEAM_DOMAIN",
    help: "Zero Trust team domain, for example https://<team>.cloudflareaccess.com (or just <team>).",
    defaultValue: null,
    allowEmpty: false,
    normalize: normalizeTeamDomain,
    validate: validateTeamDomain,
  },
  {
    name: "ACCESS_AUD",
    source: "prompt",
    hidden: false,
    label: "ACCESS_AUD",
    help: "Access application AUD tag. Press Enter if you have not created the Access application yet.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) =>
      /^[A-Za-z0-9-]{32,128}$/.test(v) ? null : "Paste the AUD tag of the Clearbox Access application.",
  },
];

export function specFor(name: SecretName): SecretSpec {
  const spec = SECRET_SPECS.find((s) => s.name === name);
  if (spec === undefined) throw new Error(`unknown secret ${name}`);
  return spec;
}

/** Compares the numeric x.y.z part of two versions (prerelease suffixes ignored). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]
      ?.split(".")
      .map((p) => Number.parseInt(p, 10) || 0) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Parses cf JSON output, tolerating text printed before the JSON document. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // fall through
      }
    }
    throw new SetupError("Could not parse cf output as JSON.");
  }
}

function unwrap(json: unknown): unknown {
  if (json !== null && typeof json === "object" && !Array.isArray(json) && "result" in json) {
    return (json as { result: unknown }).result;
  }
  return json;
}

function asRecords(json: unknown): Record<string, unknown>[] {
  const value = unwrap(json);
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object");
}

export interface DatabaseInfo {
  uuid: string;
  name: string;
  jurisdiction: string | null;
}

export function extractDatabases(json: unknown): DatabaseInfo[] {
  const out: DatabaseInfo[] = [];
  for (const r of asRecords(json)) {
    const uuid = typeof r.uuid === "string" ? r.uuid : typeof r.id === "string" ? r.id : null;
    if (uuid === null || typeof r.name !== "string") continue;
    out.push({
      uuid,
      name: r.name,
      jurisdiction: typeof r.jurisdiction === "string" ? r.jurisdiction : null,
    });
  }
  return out;
}

export function extractSecretNames(json: unknown): Set<string> {
  return new Set(asRecords(json).flatMap((r) => (typeof r.name === "string" ? [r.name] : [])));
}

export function extractWorkerId(json: unknown): string | null {
  const record = asRecords(json)[0];
  return record !== undefined && typeof record.id === "string" ? record.id : null;
}

export interface LocalConfig {
  d1DatabaseId?: string;
  appOrigin?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLocalConfig(text: string | null): LocalConfig {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupError(`${LOCAL_CONFIG_PATH} is not valid JSON. Fix or delete it.`);
  }
  const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const config: LocalConfig = {};
  if (typeof record.d1DatabaseId === "string" && UUID.test(record.d1DatabaseId)) {
    config.d1DatabaseId = record.d1DatabaseId;
  }
  if (typeof record.appOrigin === "string") {
    const origin = normalizeOrigin(record.appOrigin);
    if (origin !== null) config.appOrigin = origin;
  }
  return config;
}

export function serializeLocalConfig(config: LocalConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** https origin without path, query or fragment; null when invalid. */
export function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

export function redirectUris(origin: string): { google: string; microsoft: string } {
  return { google: `${origin}/oauth/google/callback`, microsoft: `${origin}/oauth/microsoft/callback` };
}

export function renderSecretsFile(values: SecretValues): string {
  const ordered: Record<string, string> = {};
  for (const name of SECRET_NAMES) {
    const value = values[name];
    if (value !== undefined) ordered[name] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface AccessInstructionInput {
  workerId: string | null;
  ownerEmail: string | null;
  teamDomain: string | null;
}

export function accessInstructions(input: AccessInstructionInput): string {
  const workerId = input.workerId ?? "<worker-id from: ./app/node_modules/.bin/cf workers get clearbox>";
  const email = input.ownerEmail ?? "<you@example.com>";
  const team = input.teamDomain ?? "https://<team>.cloudflareaccess.com";
  const body = JSON.stringify({
    type: "self_hosted",
    name: "Clearbox",
    destinations: [{ type: "worker", worker_id: workerId }],
    policies: [{ decision: "allow", include: [{ email: { email } }] }],
  });
  return [
    "Cloudflare Access (required: the Worker rejects every request until ACCESS_AUD is set)",
    "",
    "Option A, dashboard:",
    "  1. Workers & Pages > clearbox > Settings > Access (or the Access tab) > Protect this Worker behind Access.",
    '  2. Choose "All traffic" (this also protects the workers.dev URL), then Apply Access.',
    `  3. Zero Trust > Access controls > Applications > the new application > Policies: allow only Emails = ${email}.`,
    "  4. Same application > Configure > Additional settings: copy the Application Audience (AUD) tag.",
    "",
    "Option B, CLI (run from the repository root; the response contains the aud value):",
    `  ./app/node_modules/.bin/cf zero-trust access applications create --body '${body}'`,
    "",
    `The JWT issuer must match ACCESS_TEAM_DOMAIN (${team}).`,
  ].join("\n");
}

export function oauthInstructions(origin: string): string {
  const uris = redirectUris(origin);
  return [
    "OAuth redirect URIs (register exactly these, character for character):",
    `  Google (docs/setup-google.md):       ${uris.google}`,
    `  Microsoft (docs/setup-microsoft.md): ${uris.microsoft}`,
    "  Local development (optional):      http://localhost:5173/oauth/google/callback",
    "                                      http://localhost:5173/oauth/microsoft/callback",
    "",
    `Next: open ${origin}, sign in through Access, then open Accounts and choose Connect Gmail or Connect Outlook.`,
  ].join("\n");
}
