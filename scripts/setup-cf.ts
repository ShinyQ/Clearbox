import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateKey } from "./gen-key.ts";
import { isMain } from "./lib/is-main.ts";
import { createTerminalPrompter, type Prompter } from "./lib/prompt.ts";
import { createNodeRunner, type CommandRunner, type RunResult } from "./lib/run.ts";
import {
  CF_BIN_PATH,
  D1_NAME,
  FIRST_MIGRATION_PATH,
  LOCAL_CONFIG_PATH,
  MIGRATIONS_DIR,
  MIN_NODE_VERSION,
  MIN_PNPM_VERSION,
  SECRET_NAMES,
  SECRET_SPECS,
  SECRETS_FILE_PATH,
  SetupError,
  WORKER_NAME,
  accessInstructions,
  compareVersions,
  extractDatabases,
  extractSecretNames,
  extractWorkerId,
  normalizeOrigin,
  oauthInstructions,
  parseJsonOutput,
  parseLocalConfig,
  renderSecretsFile,
  serializeLocalConfig,
  specFor,
  type LocalConfig,
  type SecretName,
  type SecretSpec,
  type SecretValues,
} from "./lib/setup-config.ts";

export interface SetupFs {
  readText(path: string): string | null;
  writeText(path: string, text: string, mode: number): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export interface SetupFlags {
  rotateTokenKey: boolean;
  rotateStateKey: boolean;
}

export interface SetupDeps {
  repoRoot: string;
  runner: CommandRunner;
  prompter: Prompter;
  fs: SetupFs;
  log: (line: string) => void;
  generateKey: () => string;
  nodeVersion: string;
  flags: SetupFlags;
}

export interface SetupResult {
  databaseId: string;
  databaseCreated: boolean;
  uploadedSecrets: SecretName[];
  deploys: number;
  accessPending: boolean;
}

type Cf = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<RunResult>;

const MAX_ATTEMPTS = 3;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function checkPrerequisites(deps: SetupDeps, cf: Cf): Promise<void> {
  if (compareVersions(deps.nodeVersion, MIN_NODE_VERSION) < 0) {
    throw new SetupError(`Node.js ${MIN_NODE_VERSION} or newer is required (found ${deps.nodeVersion}).`);
  }
  const pnpm = await deps.runner.run("pnpm", ["--version"], { cwd: deps.repoRoot });
  if (pnpm.code !== 0 || compareVersions(pnpm.stdout, MIN_PNPM_VERSION) < 0) {
    throw new SetupError(`pnpm ${MIN_PNPM_VERSION} or newer is required. Run: corepack enable`);
  }
  if (!deps.fs.exists(join(deps.repoRoot, CF_BIN_PATH))) {
    throw new SetupError("The cf CLI is not installed in app/. Run: pnpm install");
  }
  if (!deps.fs.exists(join(deps.repoRoot, FIRST_MIGRATION_PATH))) {
    throw new SetupError(`${FIRST_MIGRATION_PATH} is missing.`);
  }
  const who = await cf(["auth", "whoami"]);
  if (who.code !== 0) {
    throw new SetupError(
      "cf is not logged in. Run ./app/node_modules/.bin/cf auth login (or export CLOUDFLARE_API_TOKEN), then re-run.",
    );
  }
  deps.log("Prerequisites OK (Node.js, pnpm, cf, cf login).");
  deps.log("Note: Clearbox uses 2 of the 5 Cron Triggers allowed per account on Workers Free.");
}

async function checkJurisdiction(deps: SetupDeps, cf: Cf, id: string): Promise<void> {
  const got = await cf(["d1", "get", id]);
  if (got.code !== 0) {
    throw new SetupError(
      `D1 database ${id} was not found. Fix d1DatabaseId in ${LOCAL_CONFIG_PATH}, or delete the file to look the database up by name.`,
    );
  }
  const info = extractDatabases(parseJsonOutput(got.stdout))[0];
  const jurisdiction = info?.jurisdiction ?? null;
  if (jurisdiction === null) {
    deps.log("Warning: cf did not report the D1 jurisdiction. Confirm in the dashboard that it is EU.");
  } else if (jurisdiction !== "eu") {
    throw new SetupError(
      `D1 database ${id} has jurisdiction "${jurisdiction}". Clearbox requires an EU database: create a new one or delete this one, then re-run.`,
    );
  }
}

async function ensureDatabase(
  deps: SetupDeps,
  cf: Cf,
  local: LocalConfig,
): Promise<{ id: string; created: boolean }> {
  if (local.d1DatabaseId !== undefined) {
    await checkJurisdiction(deps, cf, local.d1DatabaseId);
    deps.log(`Using D1 database ${local.d1DatabaseId} from ${LOCAL_CONFIG_PATH}.`);
    return { id: local.d1DatabaseId, created: false };
  }
  const listed = await cf(["d1", "list", "--name", D1_NAME]);
  if (listed.code !== 0) throw new SetupError(`cf d1 list failed: ${firstLine(listed.stderr)}`);
  const existing = extractDatabases(parseJsonOutput(listed.stdout)).find((db) => db.name === D1_NAME);
  if (existing !== undefined) {
    await checkJurisdiction(deps, cf, existing.uuid);
    const reuse = await deps.prompter.confirm(
      `Found an existing D1 database named "${D1_NAME}" (${existing.uuid}). Use it?`,
      true,
    );
    if (!reuse) throw new SetupError("Aborted. Rename or delete the existing database, then re-run.");
    return { id: existing.uuid, created: false };
  }
  deps.log(`Creating D1 database "${D1_NAME}" in the EU jurisdiction...`);
  const created = await cf(["d1", "create", "--name", D1_NAME, "--jurisdiction", "eu"]);
  if (created.code !== 0) throw new SetupError(`cf d1 create failed: ${firstLine(created.stderr)}`);
  const db = extractDatabases(parseJsonOutput(created.stdout))[0];
  if (db === undefined) throw new SetupError("cf d1 create did not return a database id.");
  deps.log(`Created D1 database ${db.uuid}.`);
  return { id: db.uuid, created: true };
}

async function listSecretNames(cf: Cf): Promise<Set<string>> {
  const res = await cf(["workers", "secrets", "list", "--worker", WORKER_NAME]);
  if (res.code !== 0) return new Set(); // Worker not deployed yet
  return extractSecretNames(parseJsonOutput(res.stdout));
}

async function promptValue(deps: SetupDeps, spec: SecretSpec): Promise<string> {
  deps.log(spec.help);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = spec.hidden
      ? await deps.prompter.askSecret(spec.label)
      : await deps.prompter.ask(spec.label, spec.defaultValue ?? undefined);
    const value = spec.normalize(raw);
    if (value === "") {
      if (spec.allowEmpty) return "";
      deps.log("A value is required.");
      continue;
    }
    const error = spec.validate(value);
    if (error === null) return value;
    deps.log(error);
  }
  throw new SetupError(`Too many invalid values for ${spec.name}.`);
}

interface Collected {
  values: SecretValues;
  accessPending: boolean;
  ownerEmail: string | null;
  teamDomain: string | null;
}

async function collectSecrets(deps: SetupDeps, existing: ReadonlySet<string>): Promise<Collected> {
  const values: SecretValues = {};
  let accessPending = false;
  for (const spec of SECRET_SPECS) {
    const present = existing.has(spec.name);
    if (spec.source === "generated") {
      const rotate = spec.name === "TOKEN_ENC_KEY" ? deps.flags.rotateTokenKey : deps.flags.rotateStateKey;
      if (!present) {
        values[spec.name] = deps.generateKey();
        deps.log(`Generated ${spec.name} (not shown and not written to disk).`);
      } else if (rotate) {
        if (spec.name === "TOKEN_ENC_KEY") {
          deps.log(
            "Rotating TOKEN_ENC_KEY makes every stored OAuth token unreadable: each account must Reconnect.",
          );
          const typed = await deps.prompter.ask('Type "rotate" to continue');
          if (typed !== "rotate") throw new SetupError("TOKEN_ENC_KEY rotation cancelled.");
        }
        values[spec.name] = deps.generateKey();
        deps.log(`Generated a new ${spec.name}.`);
      } else {
        deps.log(`${spec.name} is already set; keeping it.`);
      }
      continue;
    }
    const disabledPair =
      (spec.name === "GOOGLE_CLIENT_SECRET" && values.GOOGLE_CLIENT_ID === "") ||
      (spec.name === "MS_CLIENT_SECRET" && values.MS_CLIENT_ID === "");
    if (disabledPair) {
      values[spec.name] = "";
      continue;
    }
    if (present && !(await deps.prompter.confirm(`${spec.name} is already set. Replace it?`, false)))
      continue;
    const value = await promptValue(deps, spec);
    if (spec.name === "ACCESS_AUD" && value === "") {
      accessPending = !present;
      continue;
    }
    values[spec.name] = value;
  }
  return {
    values,
    accessPending,
    ownerEmail: values.OWNER_EMAIL ?? null,
    teamDomain: values.ACCESS_TEAM_DOMAIN ?? null,
  };
}

async function deploy(
  deps: SetupDeps,
  values: SecretValues,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const file = join(deps.repoRoot, SECRETS_FILE_PATH);
  const names = Object.keys(values);
  const args = ["run", "deploy:cf"];
  if (names.length > 0) {
    const ignored = await deps.runner.run("git", ["check-ignore", "-q", SECRETS_FILE_PATH], {
      cwd: deps.repoRoot,
    });
    if (ignored.code !== 0) {
      throw new SetupError(`${SECRETS_FILE_PATH} is not git-ignored. Refusing to write secrets there.`);
    }
    deps.fs.writeText(file, renderSecretsFile(values), 0o600);
    args.push("--secrets-file", file);
  }
  deps.log(
    names.length > 0 ? `Deploying with secrets: ${names.join(", ")}` : "Deploying (no secret changes)...",
  );
  try {
    const res = await deps.runner.run("pnpm", args, { cwd: join(deps.repoRoot, "app"), env, inherit: true });
    if (res.code !== 0) throw new SetupError("Deploy failed. Fix the error above and re-run pnpm setup:cf.");
  } finally {
    if (names.length > 0) deps.fs.remove(file);
  }
}

function workerIdFrom(stdout: string): string | null {
  try {
    return extractWorkerId(parseJsonOutput(stdout));
  } catch {
    return null; // the instructions fall back to a placeholder
  }
}

async function resolveOrigin(deps: SetupDeps, local: LocalConfig): Promise<string> {
  if (local.appOrigin !== undefined) return local.appOrigin;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const origin = normalizeOrigin(
      await deps.prompter.ask("Worker URL printed by the deploy (https://clearbox.<subdomain>.workers.dev)"),
    );
    if (origin !== null) return origin;
    deps.log("Enter an https URL without a path.");
  }
  throw new SetupError("No valid Worker URL entered.");
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const cfBin = join(deps.repoRoot, CF_BIN_PATH);
  // Account-level cf commands run from the repo root (no cloudflare.config.ts there).
  const cf: Cf = (args, env = {}) => deps.runner.run(cfBin, args, { cwd: deps.repoRoot, env });
  const localPath = join(deps.repoRoot, LOCAL_CONFIG_PATH);
  const secretsPath = join(deps.repoRoot, SECRETS_FILE_PATH);
  if (deps.fs.exists(secretsPath)) deps.fs.remove(secretsPath);

  await checkPrerequisites(deps, cf);

  const local = parseLocalConfig(deps.fs.readText(localPath));
  const db = await ensureDatabase(deps, cf, local);
  let config: LocalConfig = { ...local, d1DatabaseId: db.id };
  deps.fs.writeText(localPath, serializeLocalConfig(config), 0o600);
  const env = { CLEARBOX_D1_ID: db.id };

  deps.log("Applying D1 migrations to the remote database...");
  const migrated = await deps.runner.run(
    cfBin,
    ["d1", "migrations", "apply", db.id, "--dir", join(deps.repoRoot, MIGRATIONS_DIR)],
    { cwd: deps.repoRoot, env, inherit: true },
  );
  if (migrated.code !== 0)
    throw new SetupError("cf d1 migrations apply failed. Fix the error above and re-run.");

  const collected = await collectSecrets(deps, await listSecretNames(cf));
  const uploaded: SecretName[] = SECRET_NAMES.filter((name) => collected.values[name] !== undefined);
  await deploy(deps, collected.values, env);
  let deploys = 1;

  const after = await listSecretNames(cf);
  const missing = SECRET_NAMES.filter(
    (n) => !after.has(n) && !(n === "ACCESS_AUD" && collected.accessPending),
  );
  if (missing.length > 0) deps.log(`Warning: secrets not reported on the Worker: ${missing.join(", ")}`);

  const worker = await cf(["workers", "get", WORKER_NAME]);
  const workerId = worker.code === 0 ? workerIdFrom(worker.stdout) : null;
  const origin = await resolveOrigin(deps, config);
  config = { ...config, appOrigin: origin };
  deps.fs.writeText(localPath, serializeLocalConfig(config), 0o600);

  deps.log("");
  deps.log(
    accessInstructions({ workerId, ownerEmail: collected.ownerEmail, teamDomain: collected.teamDomain }),
  );
  let accessPending = collected.accessPending;
  if (accessPending) {
    deps.log("");
    const aud = await promptValue(deps, specFor("ACCESS_AUD"));
    if (aud === "") {
      deps.log("ACCESS_AUD is still unset. Re-run pnpm setup:cf after creating the Access application.");
    } else {
      await deploy(deps, { ACCESS_AUD: aud }, env);
      deploys++;
      uploaded.push("ACCESS_AUD");
      accessPending = false;
    }
  }
  deps.log("");
  deps.log(oauthInstructions(origin));
  return {
    databaseId: db.id,
    databaseCreated: db.created,
    uploadedSecrets: uploaded,
    deploys,
    accessPending,
  };
}

const nodeFs: SetupFs = {
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeText: (path, text, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
  },
  remove: (path) => rmSync(path, { force: true }),
  exists: (path) => existsSync(path),
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "rotate-token-key": { type: "boolean", default: false },
      "rotate-state-key": { type: "boolean", default: false },
    },
  });
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await runSetup({
      repoRoot,
      runner: createNodeRunner(),
      prompter: createTerminalPrompter(),
      fs: nodeFs,
      log: (line) => console.log(line),
      generateKey: () => generateKey(),
      nodeVersion: process.versions.node,
      flags: { rotateTokenKey: values["rotate-token-key"], rotateStateKey: values["rotate-state-key"] },
    });
    return 0;
  } catch (error) {
    if (error instanceof SetupError || (error instanceof Error && error.message === "Cancelled")) {
      console.error(`setup:cf: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
