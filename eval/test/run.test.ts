import { describe, expect, it } from "vitest";
import { parseRunArgs, readDecisionEnv } from "../src/run.ts";

describe("readDecisionEnv", () => {
  const good = {
    AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com/",
    AZURE_DECISION_KEY: "k".repeat(32),
    AZURE_DECISION_DEPLOYMENT: "decision-1",
  };

  it("reads and normalizes the three variables", () => {
    expect(readDecisionEnv(good)).toEqual({
      endpoint: "https://acct.services.ai.azure.com",
      apiKey: "k".repeat(32),
      deployment: "decision-1",
    });
  });

  it("names missing variables without echoing values", () => {
    expect(() => readDecisionEnv({ AZURE_DECISION_KEY: "secret-value" })).toThrow(
      "Missing environment variables: AZURE_DECISION_ENDPOINT, AZURE_DECISION_DEPLOYMENT",
    );
  });

  it("rejects project URLs and the reserved model name", () => {
    expect(() =>
      readDecisionEnv({
        ...good,
        AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com/api/projects/p",
      }),
    ).toThrow();
    expect(() => readDecisionEnv({ ...good, AZURE_DECISION_DEPLOYMENT: "Microsoft-Decision-1" })).toThrow(
      /deployment name/,
    );
  });
});

describe("parseRunArgs", () => {
  it("defaults to the committed fixtures and a git-ignored report path", () => {
    const o = parseRunArgs([], "stamp");
    expect(o.fixtures).toMatch(/eval[\\/]fixtures[\\/]emails\.jsonl$/);
    expect(o.out).toMatch(/eval[\\/]private[\\/]reports[\\/]eval-stamp\.md$/);
    expect(o).toMatchObject({ tauDelete: 0.8, concurrency: 2, rpm: 240, shuffle: true, limit: null });
  });

  it("parses overrides and validates ranges", () => {
    expect(parseRunArgs(["--tau", "0.9", "--no-shuffle", "--limit", "5"], "s")).toMatchObject({
      tauDelete: 0.9,
      shuffle: false,
      limit: 5,
    });
    expect(() => parseRunArgs(["--concurrency", "50"], "s")).toThrow(/--concurrency/);
  });
});
