import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Prompter } from "../lib/prompt.ts";
import type { CommandRunner, RunOptions, RunResult } from "../lib/run.ts";
import { SECRET_NAMES, SetupError } from "../lib/setup-config.ts";
import { runSetup, type SetupDeps, type SetupFlags, type SetupFs } from "../setup-cf.ts";

const ROOT = "/repo";
const CF = join(ROOT, "app/node_modules/.bin/cf");
const LOCAL = join(ROOT, "app/clearbox.local.json");
const SECRETS = join(ROOT, "app/deploy.secrets.json");
const DB_ID = "11111111-2222-4333-8444-555555555555";
const AZURE_KEY = "azure-key-value-0123456789abcdef";
const MS_SECRET = "ms-secret-value-0123456789";
const AUD = "f".repeat(64);

interface Call {
  command: string;
  args: string[];
  options: RunOptions;
}

function fakeRunner(respond: (call: Call) => Partial<RunResult> | undefined): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      async run(command, args, options = {}) {
        const call = { command, args: [...args], options };
        calls.push(call);
        const r = respond(call) ?? {};
        return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    },
  };
}

type Answer = string | boolean;

function fakePrompter(answers: Answer[]): Prompter & { remaining: () => number } {
  const queue = [...answers];
  const next = (question: string, kind: "string" | "boolean"): Answer => {
    const answer = queue.shift();
    if (answer === undefined || typeof answer !== kind)
      throw new Error(`unexpected ${kind} prompt: ${question}`);
    return answer;
  };
  return {
    async ask(question, defaultValue) {
      const answer = next(question, "string") as string;
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    async askSecret(question) {
      return next(question, "string") as string;
    },
    async confirm(question) {
      return next(question, "boolean") as boolean;
    },
    remaining: () => queue.length,
  };
}

function fakeFs(
  initial: Record<string, string>,
): SetupFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text, mode) => {
      files.set(path, text);
      modes.set(path, mode);
    },
    remove: (path) => {
      files.delete(path);
    },
    exists: (path) => files.has(path),
  };
}

const INSTALLED = { [CF]: "", [join(ROOT, "app/migrations/0001_init.sql")]: "-- sql" };

function keyFactory(): { generate: () => string; issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    generate: () => {
      const key = Buffer.alloc(32, issued.length + 1).toString("base64");
      issued.push(key);
      return key;
    },
  };
}

function deps(over: {
  runner: CommandRunner;
  prompter: Prompter;
  fs: SetupFs;
  generateKey?: () => string;
  flags?: SetupFlags;
  logs?: string[];
  onInterrupt?: SetupDeps["onInterrupt"];
}): SetupDeps {
  const logs = over.logs ?? [];
  return {
    repoRoot: ROOT,
    runner: over.runner,
    prompter: over.prompter,
    fs: over.fs,
    onInterrupt: over.onInterrupt ?? (() => () => undefined),
    log: (line) => logs.push(line),
    generateKey: over.generateKey ?? (() => Buffer.alloc(32, 9).toString("base64")),
    nodeVersion: "24.13.1",
    flags: over.flags ?? { rotateTokenKey: false, rotateStateKey: false },
  };
}

const isCf = (call: Call, ...prefix: string[]): boolean =>
  call.command === CF && prefix.every((p, i) => call.args[i] === p);

describe("runSetup, first run", () => {
  it("creates an EU database, uploads secrets through a temporary file and deploys twice", async () => {
    const fs = fakeFs({ ...INSTALLED });
    const uploads: Record<string, string>[] = [];
    let secretsListed = 0;
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2\n" };
      if (isCf(call, "d1", "list")) return { stdout: "[]" };
      if (isCf(call, "d1", "create")) return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox" }) };
      if (isCf(call, "workers", "secrets", "list")) {
        secretsListed++;
        if (secretsListed === 1) return { code: 1, stderr: "not found" };
        return {
          stdout: JSON.stringify(SECRET_NAMES.filter((n) => n !== "ACCESS_AUD").map((name) => ({ name }))),
        };
      }
      if (isCf(call, "workers", "get")) {
        if (secretsListed <= 1) return { code: 1, stderr: "Worker not found (10007)" };
        return { stdout: JSON.stringify({ id: "worker-123" }) };
      }
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") {
        const file = call.args[3];
        assert.equal(file, SECRETS);
        uploads.push(JSON.parse(fs.files.get(SECRETS) ?? "{}") as Record<string, string>);
        assert.equal(fs.modes.get(SECRETS), 0o600);
      }
      return undefined;
    });
    const prompter = fakePrompter([
      "https://acct.services.ai.azure.com/", // endpoint
      AZURE_KEY, // key (hidden)
      "", // deployment -> default decision-1
      "", // GOOGLE_CLIENT_ID empty -> Gmail disabled, secret auto-empty
      "0d9f1c2e-1111-4222-8333-444455556666", // MS_CLIENT_ID
      MS_SECRET, // MS_CLIENT_SECRET (hidden)
      "Owner@Example.test", // OWNER_EMAIL
      "my-team", // ACCESS_TEAM_DOMAIN
      "", // ACCESS_AUD not yet
      "https://clearbox.sub.workers.dev/", // Worker URL
      AUD, // ACCESS_AUD after the Access instructions
    ]);
    const keys = keyFactory();
    const logs: string[] = [];
    const result = await runSetup(deps({ runner, prompter, fs, generateKey: keys.generate, logs }));

    assert.equal(prompter.remaining(), 0);
    assert.deepEqual(result, {
      databaseId: DB_ID,
      databaseCreated: true,
      uploadedSecrets: [...SECRET_NAMES],
      deploys: 2,
      accessPending: false,
    });
    const create = calls.find((c) => isCf(c, "d1", "create"));
    assert.deepEqual(create?.args, ["d1", "create", "--name", "clearbox", "--jurisdiction", "eu"]);
    assert.equal(create?.options.cwd, ROOT);
    const migrate = calls.find((c) => isCf(c, "d1", "migrations", "apply"));
    assert.deepEqual(migrate?.args, [
      "d1",
      "migrations",
      "apply",
      DB_ID,
      "--dir",
      join(ROOT, "app/migrations"),
    ]);
    assert.equal(migrate?.options.inherit, true);

    assert.deepEqual(uploads[0], {
      AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com",
      AZURE_DECISION_KEY: AZURE_KEY,
      AZURE_DECISION_DEPLOYMENT: "decision-1",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      MS_CLIENT_ID: "0d9f1c2e-1111-4222-8333-444455556666",
      MS_CLIENT_SECRET: MS_SECRET,
      TOKEN_ENC_KEY: keys.issued[0],
      STATE_SIGNING_KEY: keys.issued[1],
      OWNER_EMAIL: "owner@example.test",
      ACCESS_TEAM_DOMAIN: "https://my-team.cloudflareaccess.com",
    });
    assert.deepEqual(uploads[1], { ACCESS_AUD: AUD });
    const deploysCalls = calls.filter((c) => c.command === "pnpm" && c.args[1] === "deploy:cf");
    for (const d of deploysCalls) {
      assert.equal(d.options.cwd, join(ROOT, "app"));
      assert.deepEqual(d.options.env, { CLEARBOX_D1_ID: DB_ID });
    }
    assert.equal(fs.files.has(SECRETS), false, "temporary secrets file is deleted");
    assert.deepEqual(JSON.parse(fs.files.get(LOCAL) ?? "{}"), {
      d1DatabaseId: DB_ID,
      appOrigin: "https://clearbox.sub.workers.dev",
    });
    const output = logs.join("\n");
    for (const secret of [AZURE_KEY, MS_SECRET, ...keys.issued]) assert.equal(output.includes(secret), false);
    assert.match(output, /"worker_id":"worker-123"/);
    assert.match(output, /https:\/\/clearbox\.sub\.workers\.dev\/oauth\/google\/callback/);
  });
});

describe("runSetup, re-run", () => {
  it("reuses the database and never regenerates keys", async () => {
    const fs = fakeFs({
      ...INSTALLED,
      [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID, appOrigin: "https://clearbox.sub.workers.dev" }),
    });
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list"))
        return { stdout: JSON.stringify(SECRET_NAMES.map((name) => ({ name }))) };
      if (isCf(call, "workers", "get")) return { stdout: JSON.stringify({ id: "worker-123" }) };
      return undefined;
    });
    const prompter = fakePrompter(Array<boolean>(10).fill(false));
    let generated = 0;
    const result = await runSetup(
      deps({
        runner,
        prompter,
        fs,
        generateKey: () => {
          generated++;
          return "unused";
        },
      }),
    );
    assert.equal(generated, 0);
    assert.equal(prompter.remaining(), 0);
    assert.equal(result.databaseCreated, false);
    assert.deepEqual(result.uploadedSecrets, []);
    assert.equal(
      calls.some((c) => isCf(c, "d1", "create") || isCf(c, "d1", "list")),
      false,
    );
    const deploy = calls.filter((c) => c.command === "pnpm" && c.args[1] === "deploy:cf");
    assert.deepEqual(
      deploy.map((c) => c.args),
      [["run", "deploy:cf"]],
    );
  });

  it("rotates TOKEN_ENC_KEY only after typed confirmation", async () => {
    const fs = fakeFs({
      ...INSTALLED,
      [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID, appOrigin: "https://c.example.workers.dev" }),
    });
    const uploads: string[] = [];
    const { runner } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list"))
        return { stdout: JSON.stringify(SECRET_NAMES.map((name) => ({ name }))) };
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") uploads.push(fs.files.get(SECRETS) ?? "");
      return undefined;
    });
    const answers: Answer[] = [...Array<boolean>(7).fill(false), "rotate", ...Array<boolean>(3).fill(false)];
    const keys = keyFactory();
    const result = await runSetup(
      deps({
        runner,
        prompter: fakePrompter(answers),
        fs,
        generateKey: keys.generate,
        flags: { rotateTokenKey: true, rotateStateKey: false },
      }),
    );
    assert.deepEqual(result.uploadedSecrets, ["TOKEN_ENC_KEY"]);
    assert.deepEqual(JSON.parse(uploads[0] ?? "{}"), { TOKEN_ENC_KEY: keys.issued[0] });
  });
});

describe("runSetup, re-run safety", () => {
  const rerunFs = (): ReturnType<typeof fakeFs> =>
    fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
  const rerunResponder =
    (listResult: Partial<RunResult>, getResult: Partial<RunResult>) =>
    (call: Call): Partial<RunResult> | undefined => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list")) return listResult;
      if (isCf(call, "workers", "get")) return getResult;
      return undefined;
    };

  it("aborts without generating or uploading when the secrets list fails for another reason", async () => {
    const fs = rerunFs();
    const { runner, calls } = fakeRunner(
      rerunResponder({ code: 1, stderr: "fetch failed: ETIMEDOUT" }, { code: 1, stderr: "fetch failed" }),
    );
    let generated = 0;
    await assert.rejects(
      runSetup(
        deps({
          runner,
          prompter: fakePrompter([]),
          fs,
          generateKey: () => {
            generated++;
            return "unused";
          },
        }),
      ),
      /Could not list secrets/,
    );
    assert.equal(generated, 0);
    assert.equal(
      calls.some((c) => c.command === "pnpm" && c.args[1] === "deploy:cf"),
      false,
    );
    assert.equal(fs.files.has(SECRETS), false);
  });

  it("aborts when the secrets list says not found but workers get shows the Worker exists", async () => {
    const fs = rerunFs();
    const { runner, calls } = fakeRunner(
      rerunResponder({ code: 1, stderr: "404 not found" }, { stdout: JSON.stringify({ id: "worker-123" }) }),
    );
    let generated = 0;
    await assert.rejects(
      runSetup(
        deps({
          runner,
          prompter: fakePrompter([]),
          fs,
          generateKey: () => {
            generated++;
            return "unused";
          },
        }),
      ),
      /Could not list secrets/,
    );
    assert.equal(generated, 0);
    assert.equal(
      calls.some((c) => c.command === "pnpm" && c.args[1] === "deploy:cf"),
      false,
    );
    assert.equal(fs.files.has(SECRETS), false);
  });

  it("proceeds to the secret prompts when workers get confirms the Worker is absent", async () => {
    const fs = rerunFs();
    const { runner } = fakeRunner(
      rerunResponder({ code: 1, stderr: "boom" }, { code: 1, stderr: "Worker not found (10007)" }),
    );
    const keys = keyFactory();
    await assert.rejects(
      runSetup(deps({ runner, prompter: fakePrompter([]), fs, generateKey: keys.generate })),
      /unexpected string prompt/,
    );
  });
});

describe("runSetup, deploy cleanup", () => {
  const prompts = (): Answer[] => [
    "https://acct.services.ai.azure.com",
    AZURE_KEY,
    "",
    "",
    "",
    "owner@example.test",
    "my-team",
    AUD,
  ];
  const absentWorker = (call: Call): Partial<RunResult> | undefined => {
    if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
    if (isCf(call, "d1", "get"))
      return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
    if (isCf(call, "workers", "secrets", "list")) return { code: 1, stderr: "not found" };
    if (isCf(call, "workers", "get")) return { code: 1, stderr: "Worker not found (10007)" };
    return undefined;
  };

  it("removes the secrets file and surfaces the error when the deploy fails", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    let sawFile = false;
    const { runner } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") {
        sawFile = fs.files.has(SECRETS);
        return { code: 1 };
      }
      return absentWorker(call);
    });
    await assert.rejects(runSetup(deps({ runner, prompter: fakePrompter(prompts()), fs })), /Deploy failed/);
    assert.equal(sawFile, true);
    assert.equal(fs.files.has(SECRETS), false);
  });

  it("removes the secrets file on SIGINT/SIGTERM and unregisters the handler afterwards", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    let cleanup: (() => void) | undefined;
    let registered = 0;
    let unregistered = 0;
    let removedByInterrupt = false;
    const { runner } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") {
        assert.equal(fs.files.has(SECRETS), true);
        cleanup?.();
        removedByInterrupt = !fs.files.has(SECRETS);
        return { code: 1 };
      }
      return absentWorker(call);
    });
    await assert.rejects(
      runSetup(
        deps({
          runner,
          prompter: fakePrompter(prompts()),
          fs,
          onInterrupt: (fn) => {
            registered++;
            cleanup = fn;
            return () => {
              unregistered++;
            };
          },
        }),
      ),
      /Deploy failed/,
    );
    assert.equal(registered, 1);
    assert.equal(removedByInterrupt, true);
    assert.equal(unregistered, 1);
  });

  it("cleans a partially written secrets file", async () => {
    const base = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    const fs: typeof base = {
      ...base,
      writeText: (path, text, mode) => {
        base.writeText(path, text, mode);
        if (path === SECRETS) throw new Error("disk full");
      },
    };
    const { runner } = fakeRunner(absentWorker);
    await assert.rejects(runSetup(deps({ runner, prompter: fakePrompter(prompts()), fs })), /disk full/);
    assert.equal(base.files.has(SECRETS), false);
  });
});

describe("runSetup, failures", () => {
  const base = (call: Call): Partial<RunResult> | undefined =>
    call.command === "pnpm" && call.args[0] === "--version" ? { stdout: "12.11.2" } : undefined;

  it("stops when cf is not logged in", async () => {
    const { runner } = fakeRunner((call) => (isCf(call, "auth", "whoami") ? { code: 1 } : base(call)));
    await assert.rejects(
      runSetup(deps({ runner, prompter: fakePrompter([]), fs: fakeFs({ ...INSTALLED }) })),
      /not logged in/,
    );
  });

  it("refuses a database outside the EU jurisdiction", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    const { runner } = fakeRunner((call) =>
      isCf(call, "d1", "get")
        ? { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "us" }) }
        : base(call),
    );
    await assert.rejects(runSetup(deps({ runner, prompter: fakePrompter([]), fs })), (e: unknown) => {
      assert.ok(e instanceof SetupError);
      assert.match(e.message, /jurisdiction "us"/);
      return true;
    });
  });

  it("requires Node.js 24.13 or newer", async () => {
    const { runner } = fakeRunner(base);
    const d = {
      ...deps({ runner, prompter: fakePrompter([]), fs: fakeFs({ ...INSTALLED }) }),
      nodeVersion: "22.18.0",
    };
    await assert.rejects(runSetup(d), /Node.js 24.13.0/);
  });

  it("refuses to write secrets to a path git does not ignore", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    const { runner } = fakeRunner((call) => {
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list")) return { code: 1, stderr: "not found" };
      if (isCf(call, "workers", "get")) return { code: 1, stderr: "Worker not found (10007)" };
      if (call.command === "git") return { code: 1 };
      return base(call);
    });
    const prompter = fakePrompter([
      "https://acct.services.ai.azure.com",
      AZURE_KEY,
      "",
      "",
      "",
      "owner@example.test",
      "my-team",
      AUD,
    ]);
    await assert.rejects(runSetup(deps({ runner, prompter, fs })), /not git-ignored/);
    assert.equal(fs.files.has(SECRETS), false);
  });
});
