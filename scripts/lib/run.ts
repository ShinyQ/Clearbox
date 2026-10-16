import { spawn } from "node:child_process";
import process from "node:process";

export interface RunOptions {
  cwd?: string;
  /** Inherit stdio so the command can prompt the user. stdout and stderr are then not captured. */
  inherit?: boolean;
  env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Real runner: spawn without a shell, so arguments are never interpreted. */
export function createNodeRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
          shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
  };
}
