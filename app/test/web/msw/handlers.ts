import type { ActionKind } from "@clearbox/core";
import { http, HttpResponse } from "msw";
import type { ApiErrorCode } from "../../../src/shared/api.ts";
import {
  createFakeApiState,
  deriveGroups,
  execute,
  inScope,
  keyOf,
  pendingItems,
  previewOf,
  sortGroups,
  summaryOf,
  toSuggestionItem,
  type FakeApiState,
  type RouteName,
} from "./fake-api.ts";
import { iso } from "./fixtures.ts";
import { server } from "./server.ts";

type Method = "get" | "post" | "put" | "patch" | "delete";
interface Ctx {
  url: URL;
  body: unknown;
  params: Record<string, string>;
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  retryAt?: string,
  details?: unknown,
): Response {
  return HttpResponse.json(
    {
      error: {
        code,
        message: "Synthetic error",
        ...(retryAt ? { retryAt } : {}),
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

function paginate<T>(list: T[], url: URL): { items: T[]; nextCursor: string | null } {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const start = Number(url.searchParams.get("cursor") ?? "0");
  return {
    items: list.slice(start, start + limit),
    nextCursor: start + limit < list.length ? String(start + limit) : null,
  };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function fakeApiHandlers(s: FakeApiState) {
  const route = (name: RouteName, method: Method, path: string, resolve: (c: Ctx) => Response) =>
    http[method](`*${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const body = method === "get" ? undefined : await readJson(request);
      const csrf = request.headers.get("X-Clearbox-CSRF");
      s.requests.push({ route: name, method: method.toUpperCase(), url, body, csrf });
      const fail = s.failures[name];
      if (fail && fail.times > 0) {
        fail.times -= 1;
        if (fail.code === "network") return HttpResponse.error();
        return errorResponse(fail.status, fail.code, fail.retryAt, fail.details);
      }
      if (method !== "get" && csrf !== "1") return errorResponse(403, "csrf_required");
      return resolve({ url, body, params: params as Record<string, string> });
    });

  return [
    route("me", "get", "/api/me", () => HttpResponse.json({ ...s.me, tauDelete: s.tau })),
    route("accounts", "get", "/api/accounts", () => HttpResponse.json({ accounts: s.accounts })),
    route("scan", "post", "/api/accounts/:id/scan", ({ params }) => {
      if (!s.accounts.some((a) => a.id === params.id)) return errorResponse(404, "not_found");
      return HttpResponse.json({
        outcome: s.scanOutcome,
        accountId: params.id ?? null,
        kind: "incremental",
        phase: "incremental",
        fetched: s.scanDecided,
        skippedKnown: 0,
        decided: s.scanDecided,
        deferred: 0,
        unsure: 0,
        removed: 0,
        subrequests: 5,
        rowsWritten: 10,
        nextTickAt: null,
        errorCode: s.scanOutcome === "error" ? "provider_error" : null,
      });
    }),
    route("patchAccount", "patch", "/api/accounts/:id", ({ params, body }) => {
      const account = s.accounts.find((a) => a.id === params.id);
      if (!account) return errorResponse(404, "not_found");
      account.paused = (body as { paused: boolean }).paused;
      return HttpResponse.json(account);
    }),
    route("deleteAccount", "delete", "/api/accounts/:id", ({ params }) => {
      const account = s.accounts.find((a) => a.id === params.id);
      if (!account) return errorResponse(404, "not_found");
      s.accounts = s.accounts.filter((a) => a.id !== account.id);
      const outlook = account.provider === "outlook";
      return HttpResponse.json({
        accountId: account.id,
        revocation: outlook ? "not_supported" : "revoked",
        consentUrls: outlook
          ? { personal: "https://account.live.com/consent/Manage", work: "https://myapps.microsoft.com" }
          : null,
      });
    }),
    route("summary", "get", "/api/queue/summary", ({ url }) =>
      HttpResponse.json(summaryOf(s, url.searchParams.get("accountId"))),
    ),
    route("groups", "get", "/api/groups", ({ url }) => {
      const action = url.searchParams.get("action");
      const groups = deriveGroups(s, url.searchParams.get("accountId")).filter(
        (g) => !action || g.action === action,
      );
      return HttpResponse.json(
        paginate(sortGroups(groups, url.searchParams.get("sort") ?? "confidence_desc"), url),
      );
    }),
    route("group", "get", "/api/groups/:key", ({ params, url }) => {
      const group = deriveGroups(s).find((g) => g.key === params.key);
      if (!group) return errorResponse(404, "not_found");
      const items = pendingItems(s)
        .filter((i) => keyOf(i) === group.key)
        .sort((a, b) => b.confidence - a.confidence || b.receivedAt.localeCompare(a.receivedAt))
        .map((i) => toSuggestionItem(s, i));
      return HttpResponse.json({
        asOf: iso(s.now),
        group,
        items: paginate(items, url),
        unsubscribe: s.unsubscribe[group.sender] ?? { oneClick: false, unsubscribedAt: null },
      });
    }),
    route("unsubscribe", "post", "/api/unsubscribe", ({ body }) => {
      const key = (body as { groupKey: string }).groupKey;
      const group = deriveGroups(s).find((g) => g.key === key);
      if (!group) return errorResponse(404, "not_found");
      const result = s.unsubscribeResult ?? {
        outcome: "unsubscribed" as const,
        error: null,
        unsubscribedAt: iso(s.now),
      };
      if (result.unsubscribedAt !== null) {
        s.unsubscribe[group.sender] = { oneClick: true, unsubscribedAt: result.unsubscribedAt };
      }
      return HttpResponse.json(result);
    }),
    route("approve", "post", "/api/approve", ({ body }) => {
      const b = body as { ids?: number[]; groupKey?: string };
      if (b.groupKey) {
        const list = pendingItems(s)
          .filter((i) => keyOf(i) === b.groupKey)
          .sort((x, y) => y.confidence - x.confidence);
        if (list[0]?.action === "unsure") return errorResponse(400, "validation_failed");
        const res = execute(
          s,
          list.slice(0, 100).map((item) => ({ item, action: item.action as ActionKind })),
          "approve",
        );
        const remaining = pendingItems(s).filter(
          (i) => keyOf(i) === b.groupKey && !s.retryLaterIds.has(i.id),
        ).length;
        return HttpResponse.json({ ...res, remaining });
      }
      const targets = pendingItems(s).filter((i) => b.ids?.includes(i.id) && i.action !== "unsure");
      const res = execute(
        s,
        targets.map((item) => ({ item, action: item.action as ActionKind })),
        "approve",
      );
      const skipped = (b.ids?.length ?? 0) - targets.length;
      return HttpResponse.json({ ...res, skipped, remaining: 0 });
    }),
    route("override", "post", "/api/override", ({ body }) => {
      const b = body as { ids: number[]; action: ActionKind };
      const targets = pendingItems(s).filter((i) => b.ids.includes(i.id));
      const res = execute(
        s,
        targets.map((item) => ({ item, action: b.action })),
        "override",
      );
      return HttpResponse.json({ ...res, skipped: b.ids.length - targets.length, remaining: 0 });
    }),
    route("preview", "get", "/api/cleanup/preview", ({ url }) => {
      const actions = (url.searchParams.get("actions") ?? "delete,archive,keep").split(",") as ActionKind[];
      const threshold = Number(url.searchParams.get("threshold") ?? s.tau);
      return HttpResponse.json(
        previewOf(s, { actions, threshold, accountId: url.searchParams.get("accountId") }),
      );
    }),
    route("cleanup", "post", "/api/cleanup", ({ body }) => {
      const b = body as { threshold?: number; actions?: ActionKind[]; accountId?: string };
      const q = {
        actions: b.actions ?? ["delete", "archive", "keep"],
        threshold: b.threshold ?? s.tau,
        accountId: b.accountId ?? null,
      };
      const batch = inScope(s, q)
        .filter((i) => !s.retryLaterIds.has(i.id))
        .slice(0, 100);
      const retry = inScope(s, q)
        .filter((i) => s.retryLaterIds.has(i.id))
        .slice(0, 100 - batch.length);
      const res = execute(
        s,
        [...batch, ...retry].map((item) => ({ item, action: item.action as ActionKind })),
        "cleanup",
      );
      return HttpResponse.json({ ...res, remaining: inScope(s, q).length });
    }),
    route("batches", "get", "/api/batches", ({ url }) =>
      HttpResponse.json(
        paginate(
          s.batches.map(({ itemIds, ...b }) => (void itemIds, b)),
          url,
        ),
      ),
    ),
    route("undo", "post", "/api/batches/:id/undo", ({ params }) => {
      const batch = s.batches.find((b) => String(b.id) === params.id);
      if (!batch) return errorResponse(404, "not_found");
      if (!batch.undoable) return errorResponse(410, "undo_expired");
      // Like the server, keep items have nothing to restore and are skipped.
      const items = s.items.filter((i) => batch.itemIds.includes(i.id));
      const kept = items.filter((i) => i.finalAction === "keep");
      const moved = items.filter((i) => i.finalAction !== "keep");
      for (const item of moved) item.status = "undone";
      batch.undoable = false;
      batch.undoneAt = iso(s.now);
      const skipped = Math.max(kept.length, batch.byAction.keep);
      const restored = Math.max(moved.length, batch.executedCount - skipped);
      return HttpResponse.json({
        batchId: batch.id,
        results: items.map((i) => ({
          id: i.id,
          outcome: i.finalAction === "keep" ? "skipped" : "restored",
          error: null,
        })),
        restored,
        failed: 0,
        skipped,
      });
    }),
    route("activity", "get", "/api/activity", ({ url }) => {
      const accountId = url.searchParams.get("accountId");
      return HttpResponse.json(
        paginate(
          s.activity.filter((e) => !accountId || e.accountId === accountId),
          url,
        ),
      );
    }),
    route("insights", "get", "/api/insights", () => HttpResponse.json(s.insights)),
    route("policy", "get", "/api/policy", () => HttpResponse.json(s.policy)),
    route("putPolicy", "put", "/api/policy", ({ body }) => {
      const b = body as { policy: FakeApiState["policy"]["policy"]; expectedVersion: number };
      if (b.expectedVersion !== s.policy.version) return errorResponse(409, "conflict");
      s.policy = { ...s.policy, policy: b.policy, version: s.policy.version + 1 };
      return HttpResponse.json(s.policy);
    }),
    route("patchSender", "patch", "/api/policy/senders", ({ body }) => {
      const b = body as { entry: string; list: "allow" | "deny" | "none" };
      const p = s.policy.policy;
      const allowlist = p.allowlist.filter((e) => e !== b.entry);
      const denylist = p.denylist.filter((e) => e !== b.entry);
      if (b.list === "allow") allowlist.push(b.entry);
      if (b.list === "deny") denylist.push(b.entry);
      s.policy = { ...s.policy, policy: { ...p, allowlist, denylist }, version: s.policy.version + 1 };
      s.ruleSuggestions = s.ruleSuggestions.filter((r) => r.entry !== b.entry);
      return HttpResponse.json(s.policy);
    }),
    route("ruleSuggestions", "get", "/api/rules/suggestions", () =>
      HttpResponse.json({ suggestions: s.ruleSuggestions }),
    ),
    route("dismissRuleSuggestion", "post", "/api/rules/suggestions/dismiss", ({ body }) => {
      const b = body as { entry: string; list: "allow" | "deny" };
      s.ruleSuggestions = s.ruleSuggestions.filter((r) => !(r.entry === b.entry && r.list === b.list));
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/** Installs the fake API for one test. `mutate` adjusts the default dataset before handlers run. */
export function installFakeApi(mutate?: (s: FakeApiState) => void): FakeApiState {
  const state = createFakeApiState();
  mutate?.(state);
  server.use(...fakeApiHandlers(state));
  return state;
}
