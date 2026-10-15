// Fails when any tracked text file contains an em dash, a private-key block or a real-looking Decision-1 key.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: "em dash (U+2014)", pattern: /\u2014/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Decision-1 key", pattern: /AZURE_DECISION_KEY=[A-Za-z0-9]{20,}/ },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "");

const problems: string[] = [];
for (const file of files) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // deleted in the working tree but still tracked
  }
  if (bytes.includes(0)) continue; // binary
  const lines = bytes.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) problems.push(`${file}:${String(index + 1)}: ${rule.name}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`check-text found ${String(problems.length)} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`check-text: ${String(files.length)} tracked files clean`);
