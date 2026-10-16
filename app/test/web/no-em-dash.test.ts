/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EM_DASH = String.fromCharCode(0x2014);
// The web suite always runs from app/ (pnpm --filter @clearbox/app exec vitest ...).
const roots = [resolve(process.cwd(), "src/web") + "/", resolve(process.cwd(), "test/web") + "/"];
const sources: Record<string, string> = Object.fromEntries(
  roots.flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx|css|sql)$/.test(f))
      .map((f) => [`${dir}${f}`, readFileSync(`${dir}${f}`, "utf8")] as const),
  ),
);

describe("text guard", () => {
  it("finds source files to scan", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
  });

  it("contains no em dash in SPA sources or tests", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes(EM_DASH))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
