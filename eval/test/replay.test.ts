import { DEFAULT_POLICY } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import {
  REPLAY_LABELS_SQL,
  REPLAY_PENDING_SQL,
  reconstructModel,
  renderReplay,
  replayLabels,
  ruleOffers,
  runReplay,
  toReplayLabel,
  toReplayPending,
  withoutModelColumn,
} from "../src/replay.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 15);

function signals(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    senderAddress: "news@shop.example.com",
    senderDomain: "example.com",
    senderName: null,
    senderKnown: true,
    ownerReplied: false,
    isCorrespondent: false,
    senderSeenCount: 0,
    senderOpenRate: null,
    ownerDeleteRate: null,
    ownerDecisions: 0,
    hasListUnsubscribe: true,
    oneClickUnsubscribe: false,
    hasListId: false,
    precedenceBulk: false,
    autoSubmitted: false,
    espDomain: null,
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    category: null,
    starred: false,
    providerImportant: false,
    ageDays: 0,
    isRead: false,
    hasAttachments: false,
    attachmentsApprox: false,
    threadDepth: 1,
    ownerPosition: "to",
    ...over,
  });
}

function raw(i: number, ownerAction: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: i,
    created_at: T0 + i * 1000,
    sender: "news@shop.example.com",
    sender_domain: "example.com",
    owner_action: ownerAction,
    suggested_action: "keep",
    p_delete: 0,
    margin: -0.9,
    s_created: T0 - DAY,
    model_p_delete: 0.2,
    p_archive: 0,
    p_keep: 1,
    p_unsure: 0,
    s_ceiling: "keep",
    flags_json: JSON.stringify({ isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 }),
    importance: 1,
    reasons_json: JSON.stringify([{ code: "guard_too_recent", params: { minAgeDays: 3 } }]),
    model_action_json: null,
    received_at: T0 - DAY,
    signals_json: signals(),
    ...over,
  };
}

describe("export SQL", () => {
  it("never selects subjects or snippets, and falls back for databases before migration 0003", () => {
    for (const sql of [REPLAY_LABELS_SQL, REPLAY_PENDING_SQL]) {
      expect(sql).not.toMatch(/subject|snippet/);
      expect(withoutModelColumn(sql)).toContain("NULL AS model_action_json");
    }
  });
});

describe("reconstructModel", () => {
  it("prefers the stored model output", () => {
    const m = reconstructModel({
      ...raw(1, "delete"),
      model_action_json: JSON.stringify({ delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1 }),
    });
    expect(m?.action.delete).toBe(0.7);
  });

  it("removes the mass a keep ceiling folded in, keeping the total at 1", () => {
    const m = reconstructModel(raw(1, "delete"));
    expect(m?.action.delete).toBeCloseTo(0.2, 9);
    const sum =
      (m?.action.delete ?? 0) + (m?.action.archive ?? 0) + (m?.action.keep ?? 0) + (m?.action.unsure ?? 0);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("replayLabels", () => {
  it("drops the too-recent cap and lets earlier decisions on the sender lift the score", () => {
    const labels = Array.from({ length: 12 }, (_, i) => toReplayLabel(raw(i, "delete")));
    const scored = replayLabels(labels, DEFAULT_POLICY);
    expect(scored).toHaveLength(12);
    expect(scored[0]?.segment).toBe("bulk");
    expect(scored[11]?.segment).toBe("sender");
    expect(scored[11]?.p ?? 0).toBeGreaterThan(scored[0]?.p ?? 1);
  });

  it("does not let labels of the same owner action see each other", () => {
    const labels = Array.from({ length: 5 }, (_, i) =>
      toReplayLabel({ ...raw(i, "delete"), created_at: T0 }),
    );
    expect(new Set(replayLabels(labels, DEFAULT_POLICY).map((s) => s.p)).size).toBe(1);
  });
});

describe("ruleOffers", () => {
  it("needs 10 trashes, 95% agreement and nothing contrary in 30 days", () => {
    const labels = [
      ...Array.from({ length: 10 }, (_, i) => toReplayLabel(raw(i, "delete"))),
      ...Array.from({ length: 10 }, (_, i) =>
        toReplayLabel({ ...raw(100 + i, "delete"), sender: "mixed@shop.example.com" }),
      ),
      toReplayLabel({ ...raw(200, "keep"), sender: "mixed@shop.example.com" }),
    ];
    expect(ruleOffers(labels, T0 + DAY)).toEqual(["news@shop.example.com"]);
  });
});

describe("runReplay", () => {
  it("reports before and after numbers and renders them without em dashes", () => {
    const labels = Array.from({ length: 200 }, (_, i) => raw(i, "delete", { created_at: T0 + i * DAY }));
    const report = runReplay(
      labels.map(toReplayLabel),
      [toReplayPending({ ...raw(999, "delete"), status: "pending", action: "keep" })],
      {},
    );
    expect(report.before.keepToTrash).toBe(200);
    expect(report.after.keepToTrash).toBeLessThan(200);
    expect(report.after.pendingScored).toBe(1);
    const text = renderReplay(report);
    expect(text).toContain("| Before, as suggested in production (all labels) |");
    expect(text).not.toContain("\u2014");
  });
});
