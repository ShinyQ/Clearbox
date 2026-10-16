import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { isMain } from "./lib/is-main.ts";

export interface TextRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** When true, a line containing ALLOW_MARKER is exempt (synthetic test values). */
  allowable: boolean;
}

export interface Finding {
  path: string;
  line: number;
  column: number;
  rule: string;
}

export const ALLOW_MARKER = "check-text: allow";
export const MAX_FILE_BYTES = 2_000_000;
export const SKIPPED_FILES: readonly string[] = ["pnpm-lock.yaml"];

export const TEXT_RULES: readonly TextRule[] = [
  {
    id: "em-dash",
    description: "U+2014 em dash; use a comma, colon, period or parentheses",
    pattern: /\u2014/g,
    allowable: false,
  },
  {
    id: "private-key",
    description: "PEM private key block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    allowable: true,
  },
  {
    id: "azure-decision-key",
    description: "AZURE_DECISION_KEY with a real-looking value",
    pattern: /AZURE_DECISION_KEY=[A-Za-z0-9]{20,}/g,
    allowable: true,
  },
  {
    id: "clearbox-secret-assignment",
    description: "Clearbox secret assigned a literal value in dotenv format",
    pattern:
      /^\s*(?:export\s+)?(?:AZURE_DECISION_KEY|TOKEN_ENC_KEY|STATE_SIGNING_KEY|GOOGLE_CLIENT_SECRET|MS_CLIENT_SECRET|ACCESS_AUD)=(?!<)\S{8,}/g,
    allowable: true,
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    allowable: true,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    allowable: true,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    allowable: true,
  },
  {
    id: "google-oauth-secret",
    description: "Google OAuth client secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
    allowable: true,
  },
  {
    id: "entra-client-secret",
    description: "Microsoft Entra client secret",
    pattern: /\b[A-Za-z0-9_.-]{3}\dQ~[A-Za-z0-9_.~-]{31,34}/g,
    allowable: true,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    allowable: true,
  },
  {
    id: "azure-storage-key",
    description: "Azure storage account key",
    pattern: /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g,
    allowable: true,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    allowable: true,
  },
];

export function scanText(path: string, text: string, rules: readonly TextRule[] = TEXT_RULES): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const allowed = line.includes(ALLOW_MARKER);
    for (const rule of rules) {
      if (allowed && rule.allowable) continue;
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({ path, line: index + 1, column: (match.index ?? 0) + 1, rule: rule.id });
      }
    }
  });
  return findings;
}

/** NUL byte in the first 8 KB means binary. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export function describeRule(id: string): string {
  return TEXT_RULES.find((rule) => rule.id === id)?.description ?? id;
}

function listFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter((path) => path.length > 0))];
}

function main(): number {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const findings: Finding[] = [];
  let scanned = 0;
  for (const path of listFiles(root)) {
    if (SKIPPED_FILES.includes(path)) continue;
    const full = join(root, path);
    let bytes: Buffer;
    let fd: number;
    try {
      fd = openSync(full, "r");
    } catch {
      continue; // deleted but still tracked
    }
    try {
      // Size check and read use the same descriptor, so the file cannot change in between.
      if (fstatSync(fd).size > MAX_FILE_BYTES) continue;
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (isProbablyBinary(bytes)) continue;
    scanned++;
    findings.push(...scanText(path, bytes.toString("utf8")));
  }
  for (const f of findings)
    console.error(`${f.path}:${f.line}:${f.column} ${f.rule}: ${describeRule(f.rule)}`);
  if (findings.length > 0) {
    console.error(
      `check-text: ${findings.length} finding(s). Remove the value, or for a synthetic test value add "${ALLOW_MARKER}" on the same line (never for em dashes).`,
    );
    return 1;
  }
  console.log(`check-text: ${scanned} files clean`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
