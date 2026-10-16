import { describe, expect, it } from "vitest";
import { REASON_CODES, REASON_TEMPLATES, renderReason } from "../../src/model/reasons.ts";

describe("REASON_TEMPLATES", () => {
  it("has exactly one template per reason code", () => {
    expect(Object.keys(REASON_TEMPLATES).sort()).toEqual([...REASON_CODES].sort());
  });

  it("contains no em dash", () => {
    for (const template of Object.values(REASON_TEMPLATES)) {
      expect(template).not.toContain("\u2014");
    }
  });
});

describe("renderReason", () => {
  it("renders a template without params", () => {
    expect(renderReason({ code: "list_unsubscribe", params: {} })).toBe("Has an unsubscribe link");
  });

  it("replaces every placeholder", () => {
    expect(
      renderReason({
        code: "prior_domain_deleted",
        params: { deletes: 14, total: 14, domain: "example.com" },
      }),
    ).toBe("You trashed 14 of 14 from example.com");
    expect(renderReason({ code: "prior_sender_deleted", params: { deletes: 3, total: 4 } })).toBe(
      "You trashed 3 of 4 from this sender",
    );
    expect(renderReason({ code: "low_open_rate", params: { openPct: 0, seen: 37 } })).toBe(
      "Opened 0% of 37 emails from this sender",
    );
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderReason({ code: "guard_too_recent", params: {} })).toBe(
      "Received less than {minAgeDays} days ago",
    );
  });
});
