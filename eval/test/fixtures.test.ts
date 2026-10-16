import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  FIXTURE_CATEGORIES,
  OWNER_ADDRESS,
  domainsIn,
  isReservedDomain,
  loadFixtures,
  parseFixtures,
  toMailMessage,
} from "../src/fixtures.ts";

const COMMITTED = fileURLToPath(new URL("../fixtures/emails.jsonl", import.meta.url));

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "syn-900",
    source: "synthetic",
    category: "promotion",
    label: "delete",
    input: {
      kind: "message",
      from: { address: "deals@shop.example.com", name: "Shop" },
      subject: "Sale",
      snippet: "Sale ends tonight",
      ageDays: 10,
      isRead: false,
    },
    ...over,
  });

describe("committed fixtures", () => {
  const fixtures = loadFixtures(COMMITTED);

  it("has 40 synthetic fixtures with unique ids", () => {
    expect(fixtures).toHaveLength(40);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(40);
    expect(fixtures.every((f) => f.source === "synthetic")).toBe(true);
  });

  it("covers every category except other, and all three labels", () => {
    const categories = new Set(fixtures.map((f) => f.category));
    for (const c of FIXTURE_CATEGORIES.filter((c) => c !== "other")) expect(categories.has(c)).toBe(true);
    expect(new Set(fixtures.map((f) => f.label))).toEqual(new Set(["delete", "archive", "keep"]));
  });

  it("uses reserved domains only", () => {
    for (const f of fixtures) {
      if (f.input.kind !== "message") throw new Error("synthetic fixtures are messages");
      for (const d of domainsIn(f.input)) expect(isReservedDomain(d), `${f.id}: ${d}`).toBe(true);
    }
  });
});

describe("parseFixtures", () => {
  it("applies defaults", () => {
    const [f] = parseFixtures(line(), "t");
    expect(f?.history).toEqual({ seenCount: 0, readCount: 0, isCorrespondent: false });
    if (f?.input.kind !== "message") throw new Error("expected message");
    expect(f.input.to).toEqual([OWNER_ADDRESS]);
    expect(f.input.headers).toEqual({});
  });

  it("rejects non-reserved domains in synthetic fixtures", () => {
    const bad = line({
      input: {
        kind: "message",
        from: { address: "a@gmail.com", name: null },
        subject: "",
        snippet: "",
        ageDays: 1,
        isRead: true,
      },
    });
    expect(() => parseFixtures(bad, "t")).toThrow(/non-reserved domain\(s\).*gmail\.com/);
  });

  it("rejects duplicate ids, bad JSON and unknown fields", () => {
    expect(() => parseFixtures(`${line()}\n${line()}`, "t")).toThrow(/duplicate id/);
    expect(() => parseFixtures("{", "t")).toThrow(/t:1: invalid JSON/);
    expect(() => parseFixtures(line({ extra: 1 }), "t")).toThrow(/t:1/);
  });
});

describe("isReservedDomain", () => {
  it("accepts RFC 2606 names and rejects real domains", () => {
    for (const d of [
      "example.com",
      "shop.example.com",
      "example.net",
      "x.example.org",
      "a.test",
      "github.example",
    ]) {
      expect(isReservedDomain(d)).toBe(true);
    }
    for (const d of ["gmail.com", "example.co", "notexample.com", "test.com"])
      expect(isReservedDomain(d)).toBe(false);
  });
});

describe("toMailMessage", () => {
  it("builds a normalized message with null header defaults", () => {
    const [f] = parseFixtures(line(), "t");
    if (f === undefined) throw new Error("missing fixture");
    const now = 1_800_000_000_000;
    const msg = toMailMessage(f, now);
    expect(msg.receivedAt).toBe(now - 10 * DAY_MS);
    expect(msg.providerMessageId).toBe("syn-900");
    expect(msg.threadId).toBe("thread-syn-900");
    expect(msg.headers.listUnsubscribe).toBeNull();
    expect(msg.headers.returnPath).toBeNull();
    expect(msg.to).toEqual([OWNER_ADDRESS]);
    expect(msg.deliveredTo).toEqual([]);
  });
});
