import { describe, expect, it } from "vitest";
import { extractSignals, type SignalContext } from "../../src/signals/signals.ts";
import { DAY_MS, TEST_NOW, makeMailMessage, makeSenderHistory } from "../fixtures/builders.ts";

const ctx: SignalContext = {
  now: TEST_NOW,
  ownerAddresses: ["owner@example.test", "alias@example.test"],
  repliedThreadIds: new Set(["thr-replied"]),
};

describe("extractSignals", () => {
  it("derives sender fields", () => {
    const s = extractSignals(makeMailMessage(), makeSenderHistory(), ctx);
    expect(s.senderAddress).toBe("news@shop.example.com");
    expect(s.senderDomain).toBe("example.com");
    expect(s.senderName).toBe("Example Shop");
    expect(s.senderKnown).toBe(true);
  });

  it("handles an unknown sender", () => {
    const s = extractSignals(
      makeMailMessage({ from: { address: null, name: "???" } }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.senderAddress, s.senderDomain, s.senderKnown]).toEqual(["", "", false]);
  });

  it("detects owner replies by thread id", () => {
    expect(
      extractSignals(makeMailMessage({ threadId: "thr-replied" }), makeSenderHistory(), ctx).ownerReplied,
    ).toBe(true);
    expect(extractSignals(makeMailMessage({ threadId: null }), makeSenderHistory(), ctx).ownerReplied).toBe(
      false,
    );
  });

  it("computes history rates", () => {
    const s = extractSignals(
      makeMailMessage(),
      makeSenderHistory({
        seenCount: 20,
        readCount: 1,
        isCorrespondent: true,
        senderPrior: { deletes: 3, keeps: 1 },
      }),
      ctx,
    );
    expect(s.senderSeenCount).toBe(20);
    expect(s.senderOpenRate).toBeCloseTo(0.05, 9);
    expect(s.ownerDeleteRate).toBeCloseTo(0.75, 9);
    expect(s.ownerDecisions).toBe(4);
    expect(s.isCorrespondent).toBe(true);
  });

  it("leaves rates null without history", () => {
    const s = extractSignals(
      makeMailMessage(),
      makeSenderHistory({ senderPrior: { deletes: 0, keeps: 0 } }),
      ctx,
    );
    expect([s.senderOpenRate, s.ownerDeleteRate, s.ownerDecisions]).toEqual([null, null, 0]);
  });

  it("reads bulk headers", () => {
    const s = extractSignals(
      makeMailMessage({
        headers: {
          listUnsubscribe: "<https://shop.example.com/u/1>, <mailto:u@shop.example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
          listId: "<deals.shop.example.com>",
          precedence: "bulk",
          autoSubmitted: "auto-generated",
          returnPath: "<bounce-123@mailer.esp.example.net>",
          authenticationResults: "mx.google.com; spf=pass smtp.mailfrom=x; dkim=fail; dmarc=fail",
        },
      }),
      makeSenderHistory(),
      ctx,
    );
    expect(s.hasListUnsubscribe).toBe(true);
    expect(s.oneClickUnsubscribe).toBe(true);
    expect(s.hasListId).toBe(true);
    expect(s.precedenceBulk).toBe(true);
    expect(s.autoSubmitted).toBe(true);
    expect(s.espDomain).toBe("example.net");
    expect(s.auth).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
  });

  it("requires an https URI for one-click unsubscribe and treats <> Return-Path as no ESP", () => {
    const s = extractSignals(
      makeMailMessage({
        headers: {
          listUnsubscribe: "<mailto:u@shop.example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
          returnPath: "<>",
        },
      }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.hasListUnsubscribe, s.oneClickUnsubscribe, s.espDomain]).toEqual([true, false, null]);
  });

  it("computes age in whole days, never negative", () => {
    expect(
      extractSignals(makeMailMessage({ receivedAt: TEST_NOW - 3 * DAY_MS - 1 }), makeSenderHistory(), ctx)
        .ageDays,
    ).toBe(3);
    expect(
      extractSignals(makeMailMessage({ receivedAt: TEST_NOW + DAY_MS }), makeSenderHistory(), ctx).ageDays,
    ).toBe(0);
  });

  it("passes message flags through", () => {
    const s = extractSignals(
      makeMailMessage({
        starred: true,
        providerImportant: true,
        category: "promotions",
        isRead: false,
        hasAttachments: true,
        attachmentsApprox: true,
        threadDepth: 4,
      }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.starred, s.providerImportant, s.category, s.isRead]).toEqual([true, true, "promotions", false]);
    expect([s.hasAttachments, s.attachmentsApprox, s.threadDepth]).toEqual([true, true, 4]);
  });

  describe("ownerPosition", () => {
    it("is to when an owner address or alias is in To", () => {
      expect(
        extractSignals(makeMailMessage({ to: ["alias@example.test"] }), makeSenderHistory(), ctx)
          .ownerPosition,
      ).toBe("to");
    });

    it("is cc when an owner address is only in Cc", () => {
      const msg = makeMailMessage({ to: ["someone@example.com"], cc: ["owner@example.test"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("cc");
    });

    it("counts Delivered-To addresses as owner addresses", () => {
      const msg = makeMailMessage({ to: ["old@example.org"], deliveredTo: ["old@example.org"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("to");
    });

    it("is bcc_or_list otherwise", () => {
      const msg = makeMailMessage({ to: ["list@example.com"], deliveredTo: ["owner@example.test"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("bcc_or_list");
    });
  });
});
