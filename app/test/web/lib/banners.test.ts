import { describe, expect, it } from "vitest";
import {
  buildAppBanners,
  collapseBanners,
  MODEL_BODY,
  visibleBanners,
  type BannerInput,
} from "../../../src/web/lib/banners.ts";
import { makeAccount, makeMe, iso, T0 } from "../msw/fixtures.ts";

const input = (over: Partial<BannerInput>): BannerInput => ({
  page: "review",
  me: makeMe(),
  accounts: [makeAccount()],
  offline: false,
  awaitingModel: 0,
  modelUnavailableShare: 0,
  resetTime: "07:00",
  dismissed: new Set(),
  ...over,
});
const titles = (i: BannerInput) => buildAppBanners(i).map((b) => `${b.tone}: ${b.title}`);

describe("buildAppBanners (UI spec 5.1, 5.9 matrix)", () => {
  it("shows reconnect banners on Review and Accounts only", () => {
    const accounts = [makeAccount({ status: "needs_reauth", email: "you@example.com" })];
    expect(buildAppBanners(input({ accounts }))[0]).toMatchObject({
      tone: "warning",
      title: "you@example.com needs to reconnect.",
      body: "Google ended the session (password change or 6 months unused). Sorting is paused for this account.",
    });
    expect(titles(input({ accounts, page: "insights" }))).toEqual([]);
  });

  it("orders error, warning, info", () => {
    const me = makeMe({
      issues: [
        { code: "budget_exhausted_today", since: iso(T0), accountId: null },
        { code: "microsoft_client_invalid", since: iso(T0), accountId: null },
      ],
    });
    const list = buildAppBanners(input({ me, awaitingModel: 25 }));
    expect(list.map((b) => b.title)).toEqual([
      "Microsoft sign-in is misconfigured.",
      "Today's free-tier limit is reached.",
      "The AI model is not responding right now.",
    ]);
    expect(list[1]?.body).toBe(
      "New mail is sorted again after 07:00. Clean up and other actions keep working until the action limit is reached.",
    );
    expect(list[2]?.body).toBe(
      '25 emails are waiting and Clearbox retries automatically. Emails it could not score are marked Check with the reason "Model unavailable".',
    );
  });

  it("words model configuration issues per code and drops the not-responding banner then", () => {
    const me = makeMe({ issues: [{ code: "decision_auth_failed", since: iso(T0), accountId: null }] });
    const list = buildAppBanners(input({ me, awaitingModel: 25 }));
    expect(list.map((b) => b.tone)).toEqual(["error"]);
    expect(list[0]?.body).toBe(
      "Azure rejected the API key. Update AZURE_DECISION_KEY and redeploy. This clears after the next successful sort. New emails are marked Check until this is fixed.",
    );
  });

  it("only promises a later clearing for the issues that clear after a successful decision", () => {
    expect(MODEL_BODY.decision_auth_failed).toContain("clears after the next successful sort");
    expect(MODEL_BODY.decision_deployment_not_found).toContain("clears after the next successful sort");
    expect(MODEL_BODY.decision_not_configured).not.toContain("clears");
    expect(MODEL_BODY.decision_not_configured).toContain("https");
    expect(MODEL_BODY.decision_not_configured).toContain("Microsoft-Decision-1");
  });

  it("shows setup errors on Setup and offline everywhere, and hides dismissed banners", () => {
    const me = makeMe({
      issues: [
        { code: "google_client_invalid", since: iso(T0), accountId: null },
        { code: "storage_near_limit", since: iso(T0), accountId: null },
      ],
    });
    expect(titles(input({ me, page: "setup", offline: true }))).toEqual([
      "error: Google sign-in is misconfigured.",
      "warning: You're offline.",
    ]);
    expect(titles(input({ me, dismissed: new Set(["storage"]) }))).toEqual([
      "error: Google sign-in is misconfigured.",
    ]);
  });

  it("collapses more than 3 banners into a final info line", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`,
      tone: "warning" as const,
      title: `T${i}.`,
    }));
    expect(collapseBanners(many).map((b) => b.title)).toEqual(["T0.", "T1.", "3 more issues. See Accounts."]);
  });
});

describe("visibleBanners", () => {
  const spec = (id: string, tone: "error" | "warning" | "info") => ({ id, tone, title: `${id}.` });

  it("hides dismissed extra banners", () => {
    const list = [spec("a", "warning"), spec("b", "info")];
    expect(visibleBanners(list, new Set(["a"])).map((b) => b.id)).toEqual(["b"]);
  });

  it("keeps an info extra from pushing an error into the N more line", () => {
    const list = [
      spec("extra-info", "info"),
      spec("w1", "warning"),
      spec("w2", "warning"),
      spec("err", "error"),
    ];
    const shown = collapseBanners(visibleBanners(list, new Set()));
    expect(shown.map((b) => b.id)).toEqual(["err", "w1", "more"]);
    expect(shown.at(-1)?.title).toBe("2 more issues. See Accounts.");
  });
});
