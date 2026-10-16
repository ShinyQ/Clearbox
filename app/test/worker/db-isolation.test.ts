/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const sources = import.meta.glob(
  [
    "../../src/worker/db/*.ts",
    "../../src/worker/actions/*.ts",
    "../../src/worker/routes/*.ts",
    "../../src/worker/oauth/*.ts",
    "../../src/worker/scan/token-source.ts",
    "../../src/worker/scan/providers.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const OWNED =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+(messages|suggestions|labels|sender_priors|senders|correspondents|sent_threads)\b/i;
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
const SCOPED = /account_id\s*=\s*\?|account_id IN \(/;
const EXEMPT = /--\s*isolation-exempt:\s*([a-z_]+)/;
const ALLOWED_EXEMPTIONS = new Set(["calibration"]);

function literals(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"/g)) {
    const text = m[1] ?? m[2] ?? "";
    if (SQL_START.test(text)) out.push(text);
  }
  return out;
}

function isScoped(sql: string): boolean {
  if (/^\s*INSERT\b/i.test(sql)) {
    const columns = /^\s*INSERT\s+INTO\s+\w+\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? "";
    return /\baccount_id\b/.test(columns);
  }
  return SCOPED.test(sql);
}

const dbFiles = Object.entries(sources).filter(([path]) => path.includes("/worker/db/"));
const otherFiles = Object.entries(sources).filter(([path]) => !path.includes("/worker/db/"));

describe("D1 account isolation (contracts 6.1)", () => {
  it("finds the repository SQL", () => {
    const count = dbFiles.flatMap(([, src]) => literals(src)).length;
    expect(count).toBeGreaterThan(20);
  });

  it("scopes every statement on account-owned tables by account_id", () => {
    const offenders: string[] = [];
    for (const [path, src] of dbFiles) {
      for (const sql of literals(src)) {
        if (!OWNED.test(sql)) continue;
        const exempt = EXEMPT.exec(sql)?.[1];
        if (exempt !== undefined) {
          if (!ALLOWED_EXEMPTIONS.has(exempt)) offenders.push(`${path}: unknown exemption ${exempt}`);
          continue;
        }
        if (!isScoped(sql)) offenders.push(`${path}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("requires accountId or accountIds on exported functions that touch account-owned tables", () => {
    const offenders: string[] = [];
    for (const [path, src] of dbFiles) {
      for (const block of src.split(/\n(?=export )/)) {
        const header = /^export (?:async )?function (\w+)(?:<[^>]*>)?\(([^)]*)\)/.exec(block);
        if (!header) continue;
        const touches = literals(block).some((sql) => OWNED.test(sql) && !EXEMPT.test(sql));
        if (touches && !/\baccountIds?\b/.test(header[2] ?? "")) offenders.push(`${path}: ${header[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps account-owned SQL out of routes, actions, oauth and scan helpers", () => {
    const offenders = otherFiles.flatMap(([path, src]) =>
      literals(src)
        .filter((sql) => OWNED.test(sql))
        .map(() => path),
    );
    expect(offenders).toEqual([]);
  });
});
