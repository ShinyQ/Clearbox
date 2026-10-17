import { describe, expect, it } from "vitest";
import {
  AUTO_TRASH_DAILY_CAP,
  autoTrashBlock,
  type AutoTrashCandidate,
} from "../../src/autotrash/autotrash.ts";
import { makePolicy, makeSignals } from "../fixtures/builders.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 2);
const SENDER = "news@shop.example.com";

function candidate(over: Partial<AutoTrashCandidate> = {}): AutoTrashCandidate {
  return {
    action: "delete",
    segment: "rule",
    ceiling: "delete",
    signals: makeSignals({ senderAddress: SENDER, senderDomain: "example.com" }),
    receivedAt: NOW - 10 * DAY,
    subject: "Weekly deals",
    snippet: "Synthetic snippet",
    ...over,
  };
}

const policy = makePolicy({ denylist: [SENDER], minAgeDays: 3 });
const withSignals = (s: Parameters<typeof makeSignals>[0]) =>
  candidate({ signals: makeSignals({ senderAddress: SENDER, senderDomain: "example.com", ...s }) });

describe("autoTrashBlock (contracts 12.11)", () => {
  it("accepts a trash suggestion from an Always OK to trash sender with no cap", () => {
    expect(autoTrashBlock(candidate(), policy, NOW)).toBeNull();
    expect(autoTrashBlock(candidate(), makePolicy({ denylist: ["@example.com"] }), NOW)).toBeNull();
  });

  it("only takes trash suggestions, never archive, keep or unsure", () => {
    for (const action of ["archive", "keep", "unsure"] as const) {
      expect(autoTrashBlock(candidate({ action }), policy, NOW)).toBe("not_trash");
    }
  });

  it("requires the sender or domain on the current Always OK to trash list", () => {
    expect(autoTrashBlock(candidate(), makePolicy({ denylist: [] }), NOW)).toBe("not_listed");
    expect(autoTrashBlock(candidate({ segment: "sender" }), policy, NOW)).toBe("not_listed");
    expect(autoTrashBlock(candidate({ segment: null }), policy, NOW)).toBe("not_listed");
  });

  it("never acts on an Always keep sender, even when also matched by a domain rule", () => {
    const both = makePolicy({ allowlist: [SENDER], denylist: ["@example.com"] });
    expect(autoTrashBlock(candidate(), both, NOW)).toBe("not_listed");
  });

  it("excludes starred or flagged email", () => {
    expect(autoTrashBlock(withSignals({ starred: true }), policy, NOW)).toBe("starred");
  });

  it("excludes email marked important by the provider", () => {
    expect(autoTrashBlock(withSignals({ providerImportant: true }), policy, NOW)).toBe("important");
  });

  it("excludes threads the owner replied to and known correspondents", () => {
    expect(autoTrashBlock(withSignals({ ownerReplied: true }), policy, NOW)).toBe("replied");
    expect(autoTrashBlock(withSignals({ isCorrespondent: true }), policy, NOW)).toBe("correspondent");
  });

  it("excludes attachments and receipts or other record words", () => {
    expect(autoTrashBlock(withSignals({ hasAttachments: true }), policy, NOW)).toBe("attachment");
    expect(autoTrashBlock(candidate({ subject: "Your receipt" }), policy, NOW)).toBe("record");
    expect(autoTrashBlock(candidate({ snippet: "the invoice is attached" }), policy, NOW)).toBe("record");
  });

  it("excludes recent mail and mail with an unknown date", () => {
    expect(autoTrashBlock(candidate({ receivedAt: NOW - DAY }), policy, NOW)).toBe("too_recent");
    expect(autoTrashBlock(candidate({ receivedAt: 0 }), policy, NOW)).toBe("too_recent");
  });

  it("excludes any suggestion whose stored ceiling is below trash", () => {
    expect(autoTrashBlock(candidate({ ceiling: "archive" }), policy, NOW)).toBe("capped");
    expect(autoTrashBlock(candidate({ ceiling: "keep" }), policy, NOW)).toBe("capped");
  });

  it("caps a day at 500 emails", () => {
    expect(AUTO_TRASH_DAILY_CAP).toBe(500);
  });
});
