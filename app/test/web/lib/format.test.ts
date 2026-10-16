import { afterEach, describe, expect, it } from "vitest";
import {
  activityWhen,
  configureFormat,
  formatCount,
  formatDayMonth,
  formatPercent,
  formatUsd,
  localResetTime,
  plural,
  relativeAgo,
  shortAge,
  truncateName,
} from "../../../src/web/lib/format.ts";

const NOW = Date.parse("2026-10-15T16:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => configureFormat({ locale: "en-GB", timeZone: "UTC" }));

describe("format", () => {
  it("formats counts and plurals", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(plural(1, "email", "emails")).toBe("1 email");
    expect(plural(1284, "email", "emails")).toBe("1,284 emails");
    expect(formatPercent(0.986, 1)).toBe("98.6%");
  });

  it("formats relative times", () => {
    expect(relativeAgo(ago(20_000), NOW)).toBe("just now");
    expect(relativeAgo(ago(4 * MIN), NOW)).toBe("4 min ago");
    expect(relativeAgo(ago(2 * HOUR), NOW)).toBe("2 h ago");
    expect(relativeAgo(ago(DAY + HOUR), NOW)).toBe("yesterday");
    expect(relativeAgo(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeAgo("2026-10-03T09:00:00.000Z", NOW)).toBe("3 Oct");
  });

  it("formats short ages for the email list", () => {
    expect(shortAge(ago(10_000), NOW)).toBe("now");
    expect(shortAge(ago(45 * MIN), NOW)).toBe("45m");
    expect(shortAge(ago(3 * HOUR), NOW)).toBe("3h");
    expect(shortAge(ago(2 * DAY), NOW)).toBe("2d");
    expect(shortAge(ago(35 * DAY), NOW)).toBe("5w");
    expect(shortAge("2024-03-10T00:00:00.000Z", NOW)).toBe("Mar 2024");
  });

  it("formats activity times", () => {
    expect(activityWhen("2026-10-15T16:21:00.000Z", NOW)).toBe("Today 16:21");
    expect(activityWhen("2026-10-14T09:02:00.000Z", NOW)).toBe("Yesterday 09:02");
    expect(activityWhen("2026-10-11T18:40:00.000Z", NOW)).toBe("Sun 11 Oct, 18:40");
  });

  it("renders the next UTC midnight in local time", () => {
    configureFormat({ locale: "en-GB", timeZone: "Asia/Jakarta" });
    expect(localResetTime(NOW)).toBe("07:00");
  });

  it("formats dates, money and names", () => {
    expect(formatDayMonth("2026-10-12", true)).toBe("12 Oct");
    expect(formatUsd(0.0588)).toBe("about $0.06");
    expect(formatUsd(0.004)).toBe("less than $0.01");
    expect(truncateName("Tokopedia Orders and Receipts Team")).toBe("Tokopedia Orders and Rec…");
    expect(truncateName("Mom")).toBe("Mom");
  });
});
