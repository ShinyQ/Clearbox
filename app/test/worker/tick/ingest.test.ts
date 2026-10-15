import {
  DEFAULT_POLICY,
  DELETE_MARGIN,
  FakeEngine,
  MIN_CONFIDENCE,
  SubrequestBudgetError,
  createSubrequestCounter,
} from "@clearbox/core";
import type { MailMessage } from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { describe, expect, it } from "vitest";
import {
  decideStage,
  emptyContext,
  finalize,
  freshKeys,
  identify,
  prepareFresh,
} from "../../../src/worker/scan/ingest.ts";
import type { IngestSettings, PageContext } from "../../../src/worker/scan/ingest.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ACCOUNT_A, DAY, MINUTE, NOW, OWNER } from "../helpers/tick-db.ts";

const S: IngestSettings = {
  policy: DEFAULT_POLICY,
  thresholds: { tauDelete: 0.8, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
  ownerAddresses: [OWNER],
  now: NOW,
  accountId: ACCOUNT_A,
};

function msg(id: string, from: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return makeMailMessage({
    providerMessageId: id,
    threadId: `t-${id}`,
    receivedAt: NOW - 10 * DAY,
    from: { address: from, name: "Shop" },
    to: [OWNER],
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    isRead: false,
    ...overrides,
  });
}

function prepared(messages: MailMessage[], ctx: PageContext = emptyContext()) {
  return prepareFresh(messages, identify(messages, S), ctx, [], S).items;
}

describe("identify and freshKeys", () => {
  it("derives lowercased sender and registrable domain, and dedupes keys", () => {
    const messages = [msg("a", "News@Mail.Shop.example"), msg("b", "news@mail.shop.example")];
    const ids = identify(messages, S);
    expect(ids[0]).toEqual({ address: "news@mail.shop.example", domain: "shop.example" });
    expect(freshKeys(messages, ids)).toEqual({
      providerIds: ["a", "b"],
      senders: ["news@mail.shop.example"],
      domains: ["shop.example"],
      threadIds: ["t-a", "t-b"],
    });
  });
});

describe("freshKeys with missing identity", () => {
  it("yields empty sender, domain and thread lists for a message without sender or thread", () => {
    const messages = [msg("a", "x@shop.example", { from: { address: null, name: null }, threadId: null })];
    const ids = identify(messages, S);
    expect(ids[0]).toEqual({ address: "", domain: "" });
    expect(freshKeys(messages, ids)).toEqual({ providerIds: ["a"], senders: [], domains: [], threadIds: [] });
  });
});

describe("prepareFresh", () => {
  it("lowercases the sender so context lookups and stored senders agree", () => {
    const ctx: PageContext = {
      ...emptyContext(),
      senders: new Map([["news@shop.example", { seen: 3, read: 0 }]]),
    };
    const items = prepared([msg("a", "News@Shop.example")], ctx);
    expect(items[0]?.signals.senderAddress).toBe("news@shop.example");
    expect(items[0]?.signals.senderSeenCount).toBe(3);
  });

  it("collapses a repeated providerMessageId on one page into one item and counts the duplicate as skipped", () => {
    const messages = [
      msg("a", "news@shop.example"),
      msg("a", "news@shop.example"),
      msg("b", "news@shop.example"),
    ];
    const { items, skippedKnown } = prepareFresh(messages, identify(messages, S), emptyContext(), [], S);
    expect(items.map((i) => i.msg.providerMessageId)).toEqual(["a", "b"]);
    expect(skippedKnown).toBe(1);
    expect(items[1]?.signals.senderSeenCount).toBe(1);
  });

  it("treats a message with no usable date (receivedAt 0) as too recent and caps the ceiling at keep", () => {
    const [item] = prepared([msg("old", "news@shop.example", { receivedAt: 0 })]);
    expect(item?.signals.ageDays).toBe(0);
    expect(item?.input.state.email.age_days).toBe(0);
    expect(item?.guard.ceiling).toBe("keep");
    expect(item?.guard.reasons.map((r) => r.code)).toContain("guard_too_recent");
    const [dated] = prepared([msg("dated", "news@shop.example")]);
    expect(dated?.guard.reasons.map((r) => r.code)).not.toContain("guard_too_recent");
  });

  it("skips known ids and accumulates sender counts across the page", () => {
    const ctx: PageContext = {
      ...emptyContext(),
      known: new Set(["k"]),
      senders: new Map([["news@shop.example", { seen: 2, read: 1 }]]),
    };
    const messages = [
      msg("k", "news@shop.example"),
      msg("a", "news@shop.example"),
      msg("b", "news@shop.example"),
      msg("c", "news@shop.example"),
    ];
    const { items, skippedKnown } = prepareFresh(messages, identify(messages, S), ctx, [], S);
    expect(skippedKnown).toBe(1);
    expect(items.map((i) => i.msg.providerMessageId)).toEqual(["a", "b", "c"]);
    const first = items[0]?.signals.senderSeenCount ?? 0;
    expect(items[2]?.signals.senderSeenCount).toBe(first + 2);
    expect(items[0]?.input.key).toBe("a");
  });

  it("treats sent items on the same page as correspondents and replied threads", () => {
    const messages = [msg("a", "alice@example.net")];
    const sent = [{ threadId: "t-a", recipients: ["alice@example.net", OWNER], sentAt: NOW - DAY }];
    const { items } = prepareFresh(messages, identify(messages, S), emptyContext(), sent, S);
    expect(items[0]?.signals.isCorrespondent).toBe(true);
    expect(items[0]?.signals.ownerReplied).toBe(true);
    expect(items[0]?.guard.ceiling).toBe("keep");
  });

  it("puts same-sender labels before same-domain labels, at most five", () => {
    const label = (id: number, sender: string) => ({
      id,
      sender,
      sender_domain: "shop.example",
      subject_trunc: `L${id}`,
      owner_action: "delete" as const,
    });
    const ctx: PageContext = {
      ...emptyContext(),
      labelsBySender: new Map([
        ["news@shop.example", [label(9, "news@shop.example"), label(8, "news@shop.example")]],
      ]),
      labelsByDomain: new Map([
        [
          "shop.example",
          [
            label(9, "news@shop.example"),
            label(7, "x@shop.example"),
            label(6, "y@shop.example"),
            label(5, "z@shop.example"),
            label(4, "w@shop.example"),
          ],
        ],
      ]),
    };
    const items = prepared([msg("a", "news@shop.example")], ctx);
    const past = items[0]?.input.state.similar_past_decisions ?? [];
    expect(past.map((p) => p.subject)).toEqual(["L9", "L8", "L7", "L6", "L5"]);
  });
});

describe("decideStage", () => {
  it("decides only what fits in the remaining subrequests and marks the stage partial", async () => {
    const items = prepared(["a", "b", "c", "d", "e"].map((id) => msg(id, `${id}@shop.example`)));
    const stage = await decideStage(new FakeEngine(), items, createSubrequestCounter(3));
    expect(stage.processed).toHaveLength(3);
    expect(stage.partial).toBe(true);
  });

  it("throws SubrequestBudgetError when no decision fits", async () => {
    const counter = createSubrequestCounter(1);
    counter.reserve(1);
    const items = prepared([msg("a", "a@shop.example")]);
    await expect(decideStage(new FakeEngine(), items, counter)).rejects.toBeInstanceOf(SubrequestBudgetError);
  });

  it("flags an outage only when at least four calls ran and most failed transiently", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const items = prepared(ids.map((id) => msg(id, `${id}@shop.example`)));
    const err = decisionError("server", 503, true, "item");
    const all = await decideStage(
      new FakeEngine({ overrides: new Map(ids.map((id) => [id, err])) }),
      items,
      createSubrequestCounter(45),
    );
    expect(all.outage).toBe(true);
    const one = await decideStage(
      new FakeEngine({ overrides: new Map([["a", err]]) }),
      items,
      createSubrequestCounter(45),
    );
    expect(one.outage).toBe(false);
    const three = await decideStage(
      new FakeEngine({ overrides: new Map(ids.slice(0, 3).map((id) => [id, err])) }),
      items.slice(0, 3),
      createSubrequestCounter(45),
    );
    expect(three.outage).toBe(false);
  });

  it("reports the first configuration error", async () => {
    const items = prepared([msg("a", "a@shop.example")]);
    const stage = await decideStage(
      new FakeEngine({ overrides: new Map([["a", decisionError("auth", 401, false, "config")]]) }),
      items,
      createSubrequestCounter(45),
    );
    expect(stage.configError?.kind).toBe("auth");
  });
});

describe("finalize", () => {
  it("maps outcomes to pending, awaiting_model and unsure per the retry schedule", async () => {
    const items = prepared(["ok", "retry", "bad"].map((id) => msg(id, `${id}@shop.example`)));
    const engine = new FakeEngine({
      overrides: new Map([
        ["retry", decisionError("timeout", null, true, "item")],
        ["bad", decisionError("unprocessable", 422, false, "item")],
      ]),
    });
    const finals = finalize(await decideStage(engine, items, createSubrequestCounter(45)), S.thresholds, NOW);
    expect(finals[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      retryAfter: null,
      modelVersion: "fake/fake-1",
    });
    expect(finals[1]).toMatchObject({
      status: "awaiting_model",
      attempts: 1,
      retryAfter: NOW + 5 * MINUTE,
      suggestion: null,
    });
    expect(finals[2]?.status).toBe("pending");
    expect(finals[2]?.suggestion?.action).toBe("unsure");
    expect(finals[2]?.suggestion?.reasons.map((r) => r.code)).toContain("model_unavailable");
  });

  it("retries a re-decided item once more after 30 minutes, then falls back to unsure", async () => {
    const [base] = prepared([msg("r", "r@shop.example")]);
    if (base === undefined) throw new Error("no item");
    const engine = new FakeEngine({
      overrides: new Map([["r", decisionError("server", 500, true, "item")]]),
    });
    const second = finalize(
      await decideStage(
        engine,
        [{ ...base, existingMessageId: 7, previousAttempts: 1 }],
        createSubrequestCounter(45),
      ),
      S.thresholds,
      NOW,
    );
    expect(second[0]).toMatchObject({ status: "awaiting_model", attempts: 2, retryAfter: NOW + 30 * MINUTE });
    const third = finalize(
      await decideStage(
        engine,
        [{ ...base, existingMessageId: 7, previousAttempts: 2 }],
        createSubrequestCounter(45),
      ),
      S.thresholds,
      NOW,
    );
    expect(third[0]).toMatchObject({ status: "pending", attempts: 3, retryAfter: null });
    expect(third[0]?.suggestion?.action).toBe("unsure");
  });
});
