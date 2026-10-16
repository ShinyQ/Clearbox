import process from "node:process";

export interface Prompter {
  /** Visible input; returns the trimmed answer, or `defaultValue` when the answer is empty. */
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Hidden input (nothing is echoed); returns the trimmed answer. */
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
}

type Input = typeof process.stdin;
type Output = typeof process.stdout;

function readLine(input: Input, output: Output, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) output.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        if (!hidden) output.write(ch);
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createTerminalPrompter(
  input: Input = process.stdin,
  output: Output = process.stdout,
): Prompter {
  if (!input.isTTY) throw new Error("pnpm setup:cf is interactive. Run it in a terminal.");
  return {
    async ask(question, defaultValue) {
      output.write(defaultValue === undefined ? `${question}: ` : `${question} [${defaultValue}]: `);
      const answer = (await readLine(input, output, false)).trim();
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    async askSecret(question) {
      output.write(`${question} (input hidden): `);
      return (await readLine(input, output, true)).trim();
    },
    async confirm(question, defaultYes) {
      output.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `);
      const answer = (await readLine(input, output, false)).trim().toLowerCase();
      if (answer === "") return defaultYes;
      return answer === "y" || answer === "yes";
    },
  };
}
