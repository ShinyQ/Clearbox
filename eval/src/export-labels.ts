import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { EvalFixtureSchema, SignalsSchema, type EvalFixture, type FixtureCategory } from "./fixtures.ts";
import { LOCAL_D1_ID, PRIVATE_DIR, REPO_ROOT, assertGitIgnored, isMain, readD1Id } from "./io.ts";

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

/** Labels joined to messages that are not purged yet (messages live 30 days after a decision). */
export function exportSql(limit: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(`limit must be 1-${MAX_LIMIT}`);
  return [
    "SELECT l.id AS label_id, l.owner_action, l.subject_trunc, m.subject, m.snippet, m.signals_json",
    "FROM labels l JOIN messages m ON m.id = l.message_id AND m.account_id = l.account_id",
    `ORDER BY l.id DESC LIMIT ${limit}`,
  ].join(" ");
}

/** Rows from `cf d1 query` (results as objects) or `cf d1 raw` (columns + rows). */
export function parseD1Rows(json: unknown): Record<string, unknown>[] {
  const root =
    json !== null && typeof json === "object" && !Array.isArray(json) && "result" in json
      ? (json as { result: unknown }).result
      : json;
  const statements = Array.isArray(root) ? root : [root];
  const rows: Record<string, unknown>[] = [];
  for (const statement of statements) {
    if (statement === null || typeof statement !== "object") continue;
    const results = (statement as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const r of results)
        if (r !== null && typeof r === "object") rows.push(r as Record<string, unknown>);
    } else if (results !== null && typeof results === "object") {
      const { columns, rows: raw } = results as { columns?: unknown; rows?: unknown };
      if (!Array.isArray(columns) || !Array.isArray(raw)) continue;
      for (const values of raw) {
        if (!Array.isArray(values)) continue;
        const record: Record<string, unknown> = {};
        columns.forEach((c, i) => {
          record[String(c)] = values[i];
        });
        rows.push(record);
      }
    }
  }
  return rows;
}

export function inferCategory(
  subject: string,
  signals: {
    category: string | null;
    hasListUnsubscribe: boolean;
    hasListId: boolean;
    isCorrespondent: boolean;
  },
): FixtureCategory {
  if (/\b(code|verification|one-time|otp|passcode)\b/i.test(subject)) return "otp";
  if (/\b(receipt|invoice|order|payment)\b/i.test(subject)) return "receipt";
  if (/\b(sign-in|sign in|security|password)\b/i.test(subject)) return "security_alert";
  if (/\b(invitation|invite|calendar|event)\b/i.test(subject)) return "calendar";
  if (signals.isCorrespondent) return "human";
  if (signals.category === "promotions") return "promotion";
  if (signals.hasListUnsubscribe || signals.hasListId) return "newsletter";
  return "other";
}

export interface ConvertResult {
  fixtures: EvalFixture[];
  skipped: number;
}

export function rowsToFixtures(rows: readonly Record<string, unknown>[]): ConvertResult {
  const fixtures: EvalFixture[] = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      const signals = SignalsSchema.parse(JSON.parse(String(r.signals_json)));
      const subject =
        typeof r.subject === "string"
          ? r.subject
          : typeof r.subject_trunc === "string"
            ? r.subject_trunc
            : "";
      const snippet = typeof r.snippet === "string" ? r.snippet : "";
      fixtures.push(
        EvalFixtureSchema.parse({
          id: `owner-${String(r.label_id)}`,
          source: "owner",
          category: inferCategory(subject, signals),
          label: r.owner_action,
          input: { kind: "signals", subject, snippet, signals },
        }),
      );
    } catch {
      skipped++;
    }
  }
  return { fixtures, skipped };
}

function main(): number {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(PRIVATE_DIR, "owner-labels.jsonl") },
      limit: { type: "string", default: String(DEFAULT_LIMIT) },
      local: { type: "boolean", default: false },
    },
  });
  const out = resolve(values.out);
  assertGitIgnored(out);
  const sql = exportSql(Number(values.limit));
  const d1Id = values.local ? LOCAL_D1_ID : readD1Id();
  const appDir = join(REPO_ROOT, "app");
  const cf = join(appDir, "node_modules", ".bin", "cf");
  // --sql=<sql> keeps SQL that starts with "--" from being parsed as a flag.
  const args = values.local
    ? [
        "d1",
        "raw",
        d1Id,
        "--local",
        "--persist-to",
        join(appDir, ".cloudflare", "state"),
        "--mode",
        "development",
        `--sql=${sql}`,
      ]
    : ["d1", "raw", d1Id, `--sql=${sql}`];
  const result = spawnSync(cf, args, {
    cwd: appDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(`cf d1 raw failed (exit ${result.status ?? "signal"}).`);
    console.error(result.stderr.split("\n").slice(0, 5).join("\n"));
    return 1;
  }
  const { fixtures, skipped } = rowsToFixtures(parseD1Rows(JSON.parse(result.stdout)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(out, 0o600);
  const counts = { delete: 0, archive: 0, keep: 0 };
  for (const f of fixtures) counts[f.label]++;
  console.log(
    `Exported ${fixtures.length} labels (delete ${counts.delete}, archive ${counts.archive}, keep ${counts.keep}); skipped ${skipped}.`,
  );
  console.log(`Wrote ${out} (git-ignored). Run: pnpm eval --fixtures ${out}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
