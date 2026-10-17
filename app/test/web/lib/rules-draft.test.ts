import { describe, expect, it } from "vitest";
import {
  addEntry,
  fieldErrors,
  policiesEqual,
  reminderDayOptions,
  reminderLocalTime,
  removeEntry,
  scanHistoryDaysOf,
  scanHistoryValue,
  validateRecordWord,
  validateSenderEntry,
} from "../../../src/web/lib/rules-draft.ts";
import { makePolicyResponse } from "../msw/fixtures.ts";

const { policy } = makePolicyResponse();

describe("rules draft", () => {
  it("maps Scan history select values to policy days and back (rev 2.4)", () => {
    for (const days of [30, 90, 365, null] as const) {
      expect(scanHistoryDaysOf(scanHistoryValue(days))).toBe(days);
    }
    expect(scanHistoryValue(null)).toBe("all");
    expect(policy.scanHistoryDays).toBe(90);
  });

  it("moves an entry between lists", () => {
    const out = addEntry(policy, "allowlist", "promo@northwind.example");
    expect(out.movedFrom).toBe("denylist");
    expect(out.policy.allowlist).toContain("promo@northwind.example");
    expect(out.policy.denylist).not.toContain("promo@northwind.example");
    expect(removeEntry(out.policy, "allowlist", "promo@northwind.example").allowlist).toEqual(
      policy.allowlist,
    );
    expect(policiesEqual(policy, { ...policy })).toBe(true);
    expect(policiesEqual(policy, out.policy)).toBe(false);
  });

  it("validates entries with the shared schema and record words locally", () => {
    expect(validateSenderEntry("  Mom@Family.Example ")).toEqual({ ok: true, value: "mom@family.example" });
    expect(validateSenderEntry("@bank.example")).toEqual({ ok: true, value: "@bank.example" });
    expect(validateSenderEntry("nope")).toEqual({ ok: false, error: "Use name@domain.com or @domain.com." });
    expect(validateRecordWord(" Invoice ")).toEqual({ ok: true, value: "invoice" });
    expect(validateRecordWord("a")).toEqual({ ok: false, error: "Use 2 to 40 characters." });
  });

  it("maps server validation paths to fields", () => {
    expect(
      fieldErrors([
        { path: "allowlist.3", message: "x" },
        { path: "recordPatterns.0", message: "y" },
        { path: "minAgeDays", message: "Too big" },
      ]),
    ).toEqual({
      allowlist: "Use name@domain.com or @domain.com.",
      recordPatterns: "Use 2 to 40 characters.",
      minAgeDays: "Too big",
    });
    expect(fieldErrors("nonsense")).toEqual({});
  });

  it("labels reminder days with the owner's local day and time of the 02:00 UTC run (contracts 12.8)", () => {
    const utc = reminderDayOptions("UTC");
    expect(utc.map((o) => o.value)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(utc.map((o) => o.label)).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    expect(reminderLocalTime("UTC")).toBe("2:00 AM");
    expect(reminderDayOptions("Asia/Jakarta")[0]?.label).toBe("Sunday");
    expect(reminderLocalTime("Asia/Jakarta")).toBe("9:00 AM");
    expect(reminderDayOptions("America/Los_Angeles")[0]).toEqual({ value: "0", label: "Saturday" });
    expect(reminderLocalTime("America/Los_Angeles")).toBe("7:00 PM");
  });
});
