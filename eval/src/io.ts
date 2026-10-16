import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root (eval/src/io.ts -> ../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EVAL_ROOT = join(REPO_ROOT, "eval");
/** Git-ignored directory for owner data and reports. */
export const PRIVATE_DIR = join(EVAL_ROOT, "private");
export const DEFAULT_FIXTURES = join(EVAL_ROOT, "fixtures", "emails.jsonl");
export const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";

export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/** Throws unless git reports `path` as ignored. Fails closed when git is unavailable. */
export function assertGitIgnored(path: string): void {
  const rel = relative(REPO_ROOT, resolve(path));
  const result = spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO_ROOT });
  if (result.status !== 0) {
    throw new Error(`${rel} is not git-ignored. Owner data may only be written under eval/private/.`);
  }
}

/** Remote D1 id: CLEARBOX_D1_ID, else app/clearbox.local.json (written by pnpm setup:cf). */
export function readD1Id(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLEARBOX_D1_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const file = join(REPO_ROOT, "app", "clearbox.local.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { d1DatabaseId?: unknown };
    if (typeof parsed.d1DatabaseId === "string") return parsed.d1DatabaseId;
  }
  throw new Error("No D1 database id. Run pnpm setup:cf or set CLEARBOX_D1_ID.");
}
