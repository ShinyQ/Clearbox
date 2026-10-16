import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DEFAULT_POLICY,
  PolicySchema,
  SenderEntrySchema,
  matchRecordPattern,
  matchesSenderList,
  parsePolicy,
} from "../../src/policy/policy.ts";

describe("SenderEntrySchema", () => {
  it("accepts addresses and @domains, trimming and lowercasing", () => {
    expect(SenderEntrySchema.parse("  News@Example.COM ")).toBe("news@example.com");
    expect(SenderEntrySchema.parse("@Example.co.uk")).toBe("@example.co.uk");
  });

  it.each(["example.com", "@localhost", "a@b", "two@@example.com", "sp ace@example.com", "@"])(
    "rejects %j",
    (value) => {
      expect(SenderEntrySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("PolicySchema", () => {
  it("accepts DEFAULT_POLICY", () => {
    expect(PolicySchema.parse(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });

  it("rejects unknown keys (strict)", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, extra: true }).success).toBe(false);
  });

  it("enforces minAgeDays bounds and integer", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: -1 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 366 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 1.5 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 0 }).success).toBe(true);
  });

  it("enforces list sizes and pattern lengths", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `u${String(i)}@example.com`);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, allowlist: many }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, recordPatterns: ["x"] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, recordPatterns: ["a".repeat(41)] }).success).toBe(
      false,
    );
  });

  it("normalizes record patterns", () => {
    expect(PolicySchema.parse({ ...DEFAULT_POLICY, recordPatterns: [" Receipt "] }).recordPatterns).toEqual([
      "receipt",
    ]);
  });
});

describe("parsePolicy", () => {
  it("returns a copy of DEFAULT_POLICY for null", () => {
    const policy = parsePolicy(null);
    expect(policy).toEqual(DEFAULT_POLICY);
    policy.allowlist.push("x@example.com");
    expect(DEFAULT_POLICY.allowlist).toEqual([]);
  });

  it("parses stored JSON", () => {
    const stored = { ...DEFAULT_POLICY, denylist: ["@spam.example.com"], minAgeDays: 7 };
    expect(parsePolicy(JSON.stringify(stored))).toEqual(stored);
  });

  it("throws ZodError for invalid JSON or an invalid policy", () => {
    expect(() => parsePolicy("{not json")).toThrow(ZodError);
    expect(() => parsePolicy(JSON.stringify({ ...DEFAULT_POLICY, minAgeDays: "3" }))).toThrow(ZodError);
  });
});

describe("matchesSenderList", () => {
  const list = ["boss@example.com", "@example.org"];

  it("matches exact addresses", () => {
    expect(matchesSenderList("boss@example.com", "example.com", list)).toBe(true);
    expect(matchesSenderList("other@example.com", "example.com", list)).toBe(false);
  });

  it("matches @domain entries for the domain and its subdomains", () => {
    expect(matchesSenderList("a@example.org", "example.org", list)).toBe(true);
    expect(matchesSenderList("a@mail.example.org", "example.org", list)).toBe(true);
    expect(matchesSenderList("a@notexample.org", "notexample.org", list)).toBe(false);
  });

  it("matches subdomain entries against the full host, not only the registrable domain", () => {
    expect(matchesSenderList("a@news.example.net", "example.net", ["@news.example.net"])).toBe(true);
    expect(matchesSenderList("a@shop.example.net", "example.net", ["@news.example.net"])).toBe(false);
  });

  it("never matches an unknown sender", () => {
    expect(matchesSenderList("", "", list)).toBe(false);
  });
});

describe("matchRecordPattern", () => {
  const patterns = DEFAULT_POLICY.recordPatterns;

  it("matches whole words case-insensitively in subject or snippet", () => {
    expect(matchRecordPattern("Your RECEIPT for order 42", "", patterns)).toBe("receipt");
    expect(matchRecordPattern("Hello", "Attached is the invoice.", patterns)).toBe("invoice");
  });

  it("ignores partial words", () => {
    expect(matchRecordPattern("Syntax tips", "Taxonomy update", patterns)).toBeNull();
    expect(matchRecordPattern("Receipts", "", ["receipt"])).toBeNull();
  });

  it("returns the first pattern in list order", () => {
    expect(matchRecordPattern("tax invoice", "", patterns)).toBe("invoice");
  });

  it("escapes regex characters in patterns", () => {
    expect(matchRecordPattern("see c++ notes", "", ["c++"])).toBe("c++");
  });
});
