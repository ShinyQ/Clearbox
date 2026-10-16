import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MaiDecisionEngine, TAU_DELETE_DEFAULT } from "@clearbox/core";
import { loadFixtures } from "./fixtures.ts";
import { DEFAULT_FIXTURES, PRIVATE_DIR, assertGitIgnored, isMain } from "./io.ts";
import { EvalAbortError, runEval } from "./pipeline.ts";
import { renderReport, summarize } from "./report.ts";

export interface DecisionEnv {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

/** Reads AZURE_DECISION_* from the process environment only (never from files in the repo). */
export function readDecisionEnv(env: NodeJS.ProcessEnv): DecisionEnv {
  const endpoint = (env.AZURE_DECISION_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.AZURE_DECISION_KEY ?? "").trim();
  const deployment = (env.AZURE_DECISION_DEPLOYMENT ?? "").trim();
  const missing = [
    endpoint === "" ? "AZURE_DECISION_ENDPOINT" : null,
    apiKey === "" ? "AZURE_DECISION_KEY" : null,
    deployment === "" ? "AZURE_DECISION_DEPLOYMENT" : null,
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (!/^https:\/\/[a-z0-9-]+\.services\.ai\.azure\.com$/i.test(endpoint)) {
    throw new Error("AZURE_DECISION_ENDPOINT must be https://<foundry-account>.services.ai.azure.com");
  }
  if (deployment.toLowerCase() === "microsoft-decision-1") {
    throw new Error(
      "AZURE_DECISION_DEPLOYMENT is the deployment name (for example decision-1), not the model name.",
    );
  }
  return { endpoint, apiKey, deployment };
}

export interface RunOptions {
  fixtures: string;
  out: string;
  tauDelete: number;
  concurrency: number;
  rpm: number;
  shuffle: boolean;
  limit: number | null;
}

export function parseRunArgs(argv: readonly string[], stamp: string): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fixtures: { type: "string", default: DEFAULT_FIXTURES },
      out: { type: "string", default: join(PRIVATE_DIR, "reports", `eval-${stamp}.md`) },
      tau: { type: "string", default: String(TAU_DELETE_DEFAULT) },
      concurrency: { type: "string", default: "2" },
      rpm: { type: "string", default: "240" },
      "no-shuffle": { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const number = (name: string, raw: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max)
      throw new Error(`--${name} must be between ${min} and ${max}`);
    return n;
  };
  return {
    fixtures: resolve(values.fixtures),
    out: resolve(values.out),
    tauDelete: number("tau", values.tau, 0.5, 0.99),
    concurrency: Math.floor(number("concurrency", values.concurrency, 1, 8)),
    rpm: number("rpm", values.rpm, 1, 1000),
    shuffle: !values["no-shuffle"],
    limit: values.limit === undefined ? null : Math.floor(number("limit", values.limit, 1, 100_000)),
  };
}

async function main(): Promise<number> {
  const generatedAt = new Date().toISOString();
  const options = parseRunArgs(process.argv.slice(2), generatedAt.replace(/[:.]/g, "-"));
  const decision = readDecisionEnv(process.env);
  const all = loadFixtures(options.fixtures);
  const fixtures = options.limit === null ? all : all.slice(0, options.limit);
  if (fixtures.some((f) => f.source === "owner")) assertGitIgnored(options.out);

  const engine = new MaiDecisionEngine({
    endpoint: decision.endpoint,
    deployment: decision.deployment,
    apiKey: decision.apiKey,
    fetch: (input, init) => fetch(input, init),
    now: () => performance.now(),
  });
  console.log(`Evaluating ${fixtures.length} fixtures against deployment ${decision.deployment}...`);
  const rows = await runEval(fixtures, {
    engine,
    clock: { now: () => performance.now(), sleep: (ms) => sleep(ms) },
    now: Date.now(),
    tauDelete: options.tauDelete,
    concurrency: options.concurrency,
    rpm: options.rpm,
    shuffle: options.shuffle,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });
  const summary = summarize(rows);
  const report = renderReport(summary, {
    generatedAt,
    deployment: decision.deployment,
    fixtures: basename(options.fixtures),
    tauDelete: options.tauDelete,
    shuffle: options.shuffle,
    concurrency: options.concurrency,
    rpm: options.rpm,
  });
  mkdirSync(resolve(options.out, ".."), { recursive: true });
  writeFileSync(options.out, report);
  console.log("");
  console.log(
    `Delete precision ${summary.fused.precision === null ? "n/a" : (summary.fused.precision * 100).toFixed(1) + "%"}, ` +
      `recall ${summary.fused.recall === null ? "n/a" : (summary.fused.recall * 100).toFixed(1) + "%"}, ` +
      `harmful deletes ${summary.harmfulDeletes.length}, model failures ${summary.failed}, ` +
      `shuffle failures ${summary.shuffleErrors}, ` +
      `shuffle flip rate ${summary.shuffleModel.flipRate === null ? "n/a" : (summary.shuffleModel.flipRate * 100).toFixed(1) + "%"}.`,
  );
  console.log(`Report: ${options.out}`);
  return summary.harmfulDeletes.length > 0 ? 2 : 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`eval: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof EvalAbortError ? 3 : 1;
  }
}
