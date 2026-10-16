import { describe, expect, it } from "vitest";
import { exportSql, inferCategory, parseD1Rows, rowsToFixtures } from "../src/export-labels.ts";

const SIGNALS = {
  senderAddress: "deals@shop.example.com",
  senderDomain: "example.com",
  senderName: "Shop",
  senderKnown: true,
  ownerReplied: false,
  isCorrespondent: false,
  senderSeenCount: 12,
  senderOpenRate: 0,
  ownerDeleteRate: 1,
  ownerDecisions: 4,
  hasListUnsubscribe: true,
  oneClickUnsubscribe: true,
  hasListId: true,
  precedenceBulk: true,
  autoSubmitted: false,
  espDomain: "example.com",
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  category: "promotions",
  starred: false,
  providerImportant: false,
  ageDays: 20,
  isRead: false,
  hasAttachments: false,
  attachmentsApprox: true,
  threadDepth: 1,
  ownerPosition: "to",
};

describe("exportSql", () => {
  it("joins labels to unpurged messages and bounds the limit", () => {
    expect(exportSql(10)).toContain("JOIN messages m ON m.id = l.message_id AND m.account_id = l.account_id");
    expect(exportSql(10)).toMatch(/LIMIT 10$/);
    expect(() => exportSql(0)).toThrow();
    expect(() => exportSql(5001)).toThrow();
    expect(() => exportSql(1.5)).toThrow();
  });
});

describe("parseD1Rows", () => {
  it("reads cf d1 query output (objects)", () => {
    expect(parseD1Rows([{ success: true, results: [{ a: 1 }, { a: 2 }], meta: {} }])).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    expect(parseD1Rows({ result: [{ results: [{ a: 1 }] }] })).toEqual([{ a: 1 }]);
  });

  it("reads cf d1 raw output (columns and rows)", () => {
    expect(parseD1Rows([{ results: { columns: ["a", "b"], rows: [[1, "x"]] } }])).toEqual([{ a: 1, b: "x" }]);
  });
});

describe("rowsToFixtures", () => {
  it("converts rows into owner fixtures and skips invalid ones", () => {
    const { fixtures, skipped } = rowsToFixtures([
      {
        label_id: 7,
        owner_action: "delete",
        subject: "Flash sale",
        snippet: null,
        subject_trunc: "Flash",
        signals_json: JSON.stringify(SIGNALS),
      },
      { label_id: 8, owner_action: "delete", subject: "x", snippet: "", signals_json: "{not json" },
      {
        label_id: 9,
        owner_action: "maybe",
        subject: "x",
        snippet: "",
        signals_json: JSON.stringify(SIGNALS),
      },
    ]);
    expect(skipped).toBe(2);
    expect(fixtures).toHaveLength(1);
    const f = fixtures[0];
    expect(f?.id).toBe("owner-7");
    expect(f?.source).toBe("owner");
    expect(f?.category).toBe("promotion");
    expect(f?.input).toMatchObject({ kind: "signals", subject: "Flash sale", snippet: "" });
  });
});

describe("inferCategory", () => {
  const base = { category: null, hasListUnsubscribe: false, hasListId: false, isCorrespondent: false };
  it("maps subjects and signals to coarse categories", () => {
    expect(inferCategory("Your verification code", base)).toBe("otp");
    expect(inferCategory("Invoice for May", base)).toBe("receipt");
    expect(inferCategory("New sign-in detected", base)).toBe("security_alert");
    expect(inferCategory("Invitation: sync", base)).toBe("calendar");
    expect(inferCategory("Lunch?", { ...base, isCorrespondent: true })).toBe("human");
    expect(inferCategory("Weekly digest", { ...base, hasListId: true })).toBe("newsletter");
    expect(inferCategory("Hello", base)).toBe("other");
  });
});
