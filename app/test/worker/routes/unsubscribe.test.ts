import { ProviderAuthError } from "@clearbox/core";
import type { FetchLike, Signals, UnsubscribeHeaders } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, GroupDetail, UnsubscribeResponse } from "../../../src/shared/api.ts";
import { postOneClick } from "../../../src/worker/actions/unsubscribe.ts";
import { createApp } from "../../../src/worker/app.ts";
import { budgetDeltaStmt } from "../../../src/worker/db/budget.ts";
import { encodeGroupKey } from "../../../src/worker/db/suggestions.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const SENDER = "news@shop.example.com";
const URL_OK = "https://shop.example.com/u/opaque-token-1";
const HOUR = 3_600_000;
const ONE_CLICK: Partial<Signals> = {
  hasListUnsubscribe: true,
  oneClickUnsubscribe: true,
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
};
const ONE_CLICK_HEADERS: UnsubscribeHeaders = {
  listUnsubscribe: `<mailto:unsub@shop.example.com>, <${URL_OK}>`,
  listUnsubscribePost: "List-Unsubscribe=One-Click",
};

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function setup(
  opts: { headers?: UnsubscribeHeaders | null; respond?: FetchLike; providerError?: Error } = {},
) {
  const sent: Sent[] = [];
  const fake = new FakeProvider();
  const respond: FetchLike = opts.respond ?? (() => Promise.resolve(new Response("ok", { status: 200 })));
  const fetch: FetchLike = (input, init) => {
    sent.push({ url: String(input), init });
    return respond(input, init);
  };
  const app = createApp({
    now: () => SEED_NOW,
    fetch,
    providerFactory: fake.factory(),
    oauth: fakeOAuth().oauth,
  });
  return {
    app,
    fake,
    sent,
    withHeaders(pid: string) {
      fake.options = {
        ...(opts.headers === null
          ? {}
          : { unsubscribeHeaders: new Map([[pid, opts.headers ?? ONE_CLICK_HEADERS]]) }),
        ...(opts.providerError ? { failWith: { unsubscribeHeaders: opts.providerError } } : {}),
      };
    },
  };
}

async function providerId(messageId: number): Promise<string> {
  const row = await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1")
    .bind(messageId)
    .first<{ provider_msg_id: string }>();
  return row?.provider_msg_id ?? "";
}

/** Two pending emails from SENDER: the newer one (index 0) carries `newest` signals. */
async function seedSender(newest: Partial<Signals> = ONE_CLICK, older: Partial<Signals> = ONE_CLICK) {
  const acc = await seedAccount();
  const ids = await seedSuggestions(acc.id, 2, (i) => ({
    sender: SENDER,
    receivedAt: SEED_NOW - (i + 1) * HOUR,
    signals: i === 0 ? newest : older,
  }));
  const key = encodeGroupKey(acc.id, SENDER, "delete");
  return { acc, key, newestPid: await providerId(ids[0] ?? 0) };
}

async function unsubscribe(app: ReturnType<typeof setup>["app"], groupKey: string) {
  return apiFetch("/api/unsubscribe", jsonInit("POST", { groupKey }), { app });
}

async function auditRows(accountId: string) {
  return (
    await env.DB.prepare(
      "SELECT kind, count, result_json FROM audit_log WHERE account_id = ?1 AND kind = 'unsubscribe' ORDER BY id",
    )
      .bind(accountId)
      .run<{ kind: string; count: number; result_json: string }>()
  ).results;
}

async function unsubscribedAt(accountId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT unsubscribed_at FROM unsubscribes WHERE account_id = ?1 AND sender = ?2",
  )
    .bind(accountId, SENDER)
    .first<{ unsubscribed_at: number }>();
  return row?.unsubscribed_at ?? null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/groups/:key unsubscribe state", () => {
  it("offers one-click when the newest pending email has it and passed DKIM", async () => {
    const { app } = setup();
    const { key } = await seedSender();
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app }));
    expect(detail.unsubscribe).toEqual({ oneClick: true, unsubscribedAt: null });
  });

  it("does not offer it when DKIM did not pass", async () => {
    const { app } = setup();
    const { key } = await seedSender({ ...ONE_CLICK, auth: { spf: "pass", dkim: "none", dmarc: "pass" } });
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app }));
    expect(detail.unsubscribe.oneClick).toBe(false);
  });

  it("looks only at the newest email from the sender", async () => {
    const { app } = setup();
    const { key } = await seedSender({ hasListUnsubscribe: true, oneClickUnsubscribe: false }, ONE_CLICK);
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app }));
    expect(detail.unsubscribe.oneClick).toBe(false);
  });
});

describe("POST /api/unsubscribe", () => {
  it("POSTs the RFC 8058 body to the newest email's https URL and records the sender", async () => {
    const t = setup();
    const { acc, key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    const res = await unsubscribe(t.app, key);
    expect(res.status).toBe(200);
    expect(await readJson<UnsubscribeResponse>(res)).toEqual({
      outcome: "unsubscribed",
      error: null,
      unsubscribedAt: new Date(SEED_NOW).toISOString(),
    });
    expect(t.fake.calls.map((c) => [c.method, c.ids])).toEqual([["unsubscribeHeaders", [newestPid]]]);
    expect(t.sent).toHaveLength(1);
    const [post] = t.sent;
    expect(post?.url).toBe(URL_OK);
    expect(post?.init?.method).toBe("POST");
    expect(post?.init?.body).toBe("List-Unsubscribe=One-Click");
    expect(post?.init?.redirect).toBe("manual");
    const headers = new Headers(post?.init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await unsubscribedAt(acc.id)).toBe(SEED_NOW);
    expect(await auditRows(acc.id)).toEqual([
      {
        kind: "unsubscribe",
        count: 1,
        result_json: JSON.stringify({ outcome: "unsubscribed", status: 200 }),
      },
    ]);
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app: t.app }));
    expect(detail.unsubscribe.unsubscribedAt).toBe(new Date(SEED_NOW).toISOString());
  });

  it("never logs the URL, the sender or the response", async () => {
    const t = setup();
    const { key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await unsubscribe(t.app, key);
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"evt":"unsubscribe.done"');
    expect(logged).not.toContain("shop.example.com");
    expect(logged).not.toContain("opaque-token");
  });

  it.each([
    [302, "sender_redirect"],
    [404, "sender_rejected"],
    [500, "sender_rejected"],
  ])("reports a %i answer as %s and records nothing", async (status, error) => {
    const t = setup({ respond: () => Promise.resolve(new Response(null, { status })) });
    const { acc, key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    const body = await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key));
    expect(body).toEqual({ outcome: "failed", error, unsubscribedAt: null });
    expect(t.sent).toHaveLength(1);
    expect(await unsubscribedAt(acc.id)).toBeNull();
    expect(await auditRows(acc.id)).toEqual([
      { kind: "unsubscribe", count: 0, result_json: JSON.stringify({ outcome: error, status }) },
    ]);
  });

  it("reports a network failure as sender_unreachable", async () => {
    const t = setup({ respond: () => Promise.reject(new TypeError("Network connection lost")) });
    const { key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    expect((await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key))).error).toBe(
      "sender_unreachable",
    );
  });

  it.each([
    ["http://shop.example.com/u/1"],
    ["https://127.0.0.1/u/1"],
    ["https://169.254.169.254/latest/meta-data"],
    ["https://localhost/u/1"],
    ["https://shop.example.com:8443/u/1"],
    ["https://user:pw@shop.example.com/u/1"],
    ["https://clearbox.example.test/api/accounts"],
  ])("refuses the unsafe URL %s without sending anything", async (url) => {
    const t = setup({
      headers: { listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click" },
    });
    const { acc, key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    const body = await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key));
    // http:// is not an https URI at all, so the header no longer offers one-click.
    expect(body.error).toBe(url.startsWith("http:") ? "not_available" : "unsafe_url");
    expect(t.sent).toHaveLength(0);
    expect(await unsubscribedAt(acc.id)).toBeNull();
  });

  it("does not read the provider when the stored signals offer no one-click", async () => {
    const t = setup();
    const { key } = await seedSender({ hasListUnsubscribe: true, oneClickUnsubscribe: false });
    const body = await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key));
    expect(body.error).toBe("not_available");
    expect(t.fake.calls).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
  });

  it("re-checks the live headers: no one-click pair, mailto only, or a gone message", async () => {
    for (const [headers, error] of [
      [{ listUnsubscribe: `<${URL_OK}>`, listUnsubscribePost: null }, "not_available"],
      [
        { listUnsubscribe: "<mailto:u@shop.example.com>", listUnsubscribePost: "List-Unsubscribe=One-Click" },
        "not_available",
      ],
      [null, "message_gone"],
    ] as const) {
      const t = setup({ headers });
      const { key, newestPid } = await seedSender();
      t.withHeaders(newestPid);
      expect((await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key))).error).toBe(error);
      expect(t.sent).toHaveLength(0);
    }
  });

  it("marks the account on a provider auth error and sends nothing", async () => {
    const t = setup({ providerError: new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" }) });
    const { acc, key, newestPid } = await seedSender();
    t.withHeaders(newestPid);
    expect((await readJson<UnsubscribeResponse>(await unsubscribe(t.app, key))).error).toBe(
      "account_inactive",
    );
    expect(t.sent).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status FROM accounts WHERE id = ?1")
      .bind(acc.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("needs_reauth");
  });

  it("refuses an inactive account before any provider call", async () => {
    const t = setup();
    const acc = await seedAccount({ status: "needs_reauth" });
    await seedSuggestions(acc.id, 1, { sender: SENDER, signals: ONE_CLICK });
    const body = await readJson<UnsubscribeResponse>(
      await unsubscribe(t.app, encodeGroupKey(acc.id, SENDER, "delete")),
    );
    expect(body.error).toBe("account_inactive");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("validates the request", async () => {
    const t = setup();
    const acc = await seedAccount();
    const code = async (res: Response) => (await readJson<ApiErrorBody>(res)).error.code;
    expect(await code(await unsubscribe(t.app, "bad"))).toBe("validation_failed");
    expect(await code(await unsubscribe(t.app, encodeGroupKey(acc.id, "", "delete")))).toBe(
      "validation_failed",
    );
    expect(
      await code(
        await apiFetch("/api/unsubscribe", jsonInit("POST", { groupKey: "k", extra: 1 }), { app: t.app }),
      ),
    ).toBe("validation_failed");
    const unknown = await unsubscribe(t.app, encodeGroupKey("acc_ffffffffffffffff", SENDER, "delete"));
    expect(unknown.status).toBe(404);
    const noCsrf = await apiFetch("/api/unsubscribe", jsonInit("POST", { groupKey: "k" }), {
      app: t.app,
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    expect(t.sent).toHaveLength(0);
  });

  it("answers 429 budget_exhausted at the daily cap", async () => {
    const t = setup();
    const { key } = await seedSender();
    const date = new Date(SEED_NOW).toISOString().slice(0, 10);
    await budgetDeltaStmt(env.DB, date, { rowsWritten: 95_000 }, SEED_NOW).run();
    const res = await unsubscribe(t.app, key);
    expect(res.status).toBe(429);
    expect(t.sent).toHaveLength(0);
    await budgetDeltaStmt(env.DB, date, { rowsWritten: -95_000 }, SEED_NOW).run();
  });
});

describe("postOneClick", () => {
  it("times out without following anything", async () => {
    const hang: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    expect(await postOneClick(hang, URL_OK, 10)).toEqual({
      ok: false,
      error: "sender_timeout",
      status: null,
    });
  });

  it("cancels the response body unread", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = await postOneClick(() => Promise.resolve(new Response(body, { status: 202 })), URL_OK);
    expect(res).toEqual({ ok: true, status: 202 });
    expect(pulled).toBeLessThanOrEqual(1);
  });
});
