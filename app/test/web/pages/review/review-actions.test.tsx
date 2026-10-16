import { act, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueSummary, SenderGroup } from "../../../../src/shared/api.ts";
import { qk } from "../../../../src/web/api/keys.ts";
import { groupsInCache } from "../../../../src/web/pages/review/group-cache.ts";
import { useGroupActions, type GroupActionsApi } from "../../../../src/web/pages/review/use-group-actions.ts";
import { useItemActions } from "../../../../src/web/pages/review/use-item-actions.ts";
import { useUndoStack, type UndoStackApi } from "../../../../src/web/state/UndoStackProvider.tsx";
import { renderWithCore } from "../../helpers/core.tsx";
import { createTestQueryClient } from "../../helpers/query.tsx";
import { setReducedMotion } from "../../helpers/viewport.ts";
import {
  deriveGroups,
  keyOf,
  pendingItems,
  sortGroups,
  summaryOf,
  toSuggestionItem,
  type FakeApiState,
} from "../../msw/fake-api.ts";
import { iso, T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";
import { server } from "../../msw/server.ts";

let actions: GroupActionsApi | null = null;
let items: ReturnType<typeof useItemActions> | null = null;
let stack: UndoStackApi | null = null;
const calls = { removed: [] as string[][], restored: [] as string[] };

function Harness() {
  const cb = {
    onRemoved: (k: string[]) => calls.removed.push(k),
    onRestored: (k: string) => calls.restored.push(k),
    onDelta: () => undefined,
    errorContext: () => ({ providerLabel: "Gmail", resetTime: "07:00" }),
    accountFor: () => undefined,
  };
  stack = useUndoStack();
  actions = useGroupActions(cb);
  items = useItemActions(actions, cb);
  return null;
}

function setup(mutate?: (s: FakeApiState) => void) {
  setReducedMotion(true);
  const state = installFakeApi(mutate);
  const client = createTestQueryClient();
  const groups = sortGroups(deriveGroups(state), "confidence_desc");
  client.setQueryData(qk.groups({ sort: "confidence_desc" }), {
    pages: [{ items: groups, nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(qk.summary(), summaryOf(state));
  renderWithCore(<Harness />, { client });
  const byName = (n: string): SenderGroup => groups.find((g) => g.senderName === n)!;
  return { state, client, groups, byName };
}

const asOf = iso(T0);
afterEach(() => {
  calls.removed = [];
  calls.restored = [];
});

describe("useGroupActions", () => {
  it("approves a Trash group by key, removes the row, updates counts and offers Undo", async () => {
    const { state, client, byName } = setup();
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(state.requests.find((r) => r.route === "approve")?.body).toEqual({ groupKey: north.key, asOf });
    await waitFor(() => expect(groupsInCache(client).map((g) => g.key)).not.toContain(north.key));
    expect(client.getQueryData<QueueSummary>(qk.summary())?.pending.total).toBe(21);
    expect(screen.getByText("Moved 6 emails from Northwind Deals to Trash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(calls.removed).toContainEqual([north.key]);
  });

  it("shows no Undo and pushes no undo entry when a Keep group is approved", async () => {
    const { state, byName } = setup();
    await act(async () => {
      await actions?.act(byName("Mom"), "keep", asOf);
    });
    expect(state.requests.some((r) => r.route === "approve")).toBe(true);
    expect(screen.getByText("Kept 2 emails from Mom. Clearbox will remember.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });

  it("shows no Undo when a Check group is overridden to Keep", async () => {
    const { state, byName } = setup();
    await act(async () => {
      await actions?.act(byName("Build Bot"), "keep", asOf);
    });
    expect(state.requests.some((r) => r.route === "override")).toBe(true);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });

  it("shows no Undo on the partial toast of a keep-only group", async () => {
    const { byName } = setup((s) => {
      s.retryLaterIds = new Set([1500]);
    });
    await act(async () => {
      await actions?.act(byName("Mom"), "keep", asOf);
    });
    expect(screen.getByText(/^Kept 1 of 2 emails\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });

  it("keeps Undo and the undo entry when a Check group is overridden to Trash", async () => {
    const { byName } = setup();
    await act(async () => {
      await actions?.act(byName("Build Bot"), "delete", asOf);
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(stack?.size).toBe(1);
  });

  it("rolls back the row and counts on error", async () => {
    const { client, byName } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(groupsInCache(client).map((g) => g.key)).toContain(north.key);
    expect(client.getQueryData<QueueSummary>(qk.summary())?.pending.total).toBe(27);
    expect(screen.getByText("Something went wrong. Nothing was changed.")).toBeTruthy();
    expect(calls.restored).toEqual([north.key]);
  });

  it("restores only the failed group when concurrent actions end differently", async () => {
    const { client, groups, byName } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    const failing = byName("Northwind Deals");
    const succeeding = byName("Daily Digest");
    const before = client.getQueryData<QueueSummary>(qk.summary())?.pending.total ?? 0;
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([
        actions?.act(failing, "delete", asOf) ?? false,
        actions?.act(succeeding, "delete", asOf) ?? false,
      ]);
    });
    expect(results).toEqual([false, true]);
    expect(groupsInCache(client).map((g) => g.key)).toEqual(
      groups.map((g) => g.key).filter((k) => k !== succeeding.key),
    );
    await waitFor(() =>
      expect(client.getQueryData<QueueSummary>(qk.summary())?.pending.total).toBe(before - succeeding.count),
    );
    expect(calls.restored).toEqual([failing.key]);
  });

  it("keeps the row in its exiting state until the request settles, then cancels the exit on error", async () => {
    const { client, byName } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    setReducedMotion(false);
    const north = byName("Northwind Deals");
    let pending: Promise<boolean> | undefined;
    act(() => {
      pending = actions?.act(north, "delete", asOf);
    });
    expect(actions?.exitingKeys.has(north.key)).toBe(true);
    await act(async () => {
      await pending;
    });
    expect(actions?.exitingKeys.has(north.key)).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(groupsInCache(client).map((g) => g.key)).toContain(north.key);
    expect(calls.removed).toEqual([]);
  });

  it("re-inserts a partially executed group with the remaining count", async () => {
    const { client, byName } = setup((s) => {
      s.retryLaterIds = new Set([1004, 1005]);
    });
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(
      screen.getByText("Moved 4 of 6 emails to Trash. 2 could not be moved and stay in Review."),
    ).toBeTruthy();
    expect(groupsInCache(client).find((g) => g.key === north.key)?.count).toBe(2);
  });

  it("overrides a Check group page by page", async () => {
    const { state, byName } = setup();
    const bot = byName("Build Bot");
    const ids = pendingItems(state)
      .filter((i) => keyOf(i) === bot.key)
      .sort((a, b) => b.confidence - a.confidence)
      .map((i) => i.id);
    await act(async () => {
      await actions?.act(bot, "delete", asOf);
    });
    expect(state.requests.filter((r) => r.route === "group")[0]?.url.searchParams.get("limit")).toBe("100");
    expect(state.requests.find((r) => r.route === "override")?.body).toEqual({ ids, action: "delete" });
    expect(screen.getByText("Moved 5 emails from Build Bot to Trash.")).toBeTruthy();
  });

  it("approves a selection and reports one summary toast", async () => {
    const { byName } = setup();
    await act(async () => {
      await actions?.bulk([byName("Northwind Deals"), byName("Contoso Orders")], "approve", asOf);
    });
    expect(screen.getByText("Done: 6 to Trash, 3 archived.")).toBeTruthy();
  });

  it("shows no Undo for a keep-only bulk approve", async () => {
    const { byName } = setup();
    await act(async () => {
      await actions?.bulk([byName("Mom")], "approve", asOf);
    });
    expect(screen.getByText("Done: 2 kept.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });

  it("keeps Undo for a mixed bulk approve that includes keeps", async () => {
    const { byName } = setup();
    await act(async () => {
      await actions?.bulk([byName("Northwind Deals"), byName("Mom")], "approve", asOf);
    });
    expect(screen.getByText("Done: 6 to Trash, 2 kept.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(stack?.size).toBe(1);
  });

  it("leaves a running bulk alone when another or an empty bulk is requested", async () => {
    const { state, byName } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    server.use(http.post("*/api/approve", async () => void (await gate)));
    let running: Promise<string[]> = Promise.resolve([]);
    act(() => {
      running = actions?.bulk([byName("Northwind Deals"), byName("Build Bot")], "delete", asOf) ?? running;
    });
    await waitFor(() => expect(actions?.bulkProgress).toEqual({ done: 1, total: 2 }));
    const busy = actions?.busyKeys;
    let extra: string[][] = [];
    await act(async () => {
      extra = await Promise.all([
        actions?.bulk([], "delete", asOf) ?? Promise.resolve(["unexpected"]),
        actions?.bulk([byName("Daily Digest")], "delete", asOf) ?? Promise.resolve(["unexpected"]),
      ]);
    });
    expect(extra).toEqual([[], []]);
    expect(actions?.bulkProgress).toEqual({ done: 1, total: 2 });
    expect(actions?.busyKeys).toBe(busy);
    release();
    await act(() => running);
    expect(state.requests.filter((r) => r.route === "approve" || r.route === "override")).toHaveLength(2);
  });

  it("stops a bulk action at the budget limit and keeps the rest", async () => {
    const { state, client, byName } = setup((s) => {
      s.failures.approve = { status: 429, code: "budget_exhausted", times: 1 };
    });
    let done: string[] = [];
    await act(async () => {
      done =
        (await actions?.bulk(
          [byName("Build Bot"), byName("Northwind Deals"), byName("Daily Digest")],
          "delete",
          asOf,
        )) ?? [];
    });
    expect(done).toEqual([byName("Build Bot").key]);
    expect(state.requests.filter((r) => r.route === "approve")).toHaveLength(1);
    expect(screen.getByText("Moved 5 emails from 1 sender group to Trash.")).toBeTruthy();
    expect(
      screen.getByText("Today's free-tier limit for changes is reached. Try again after 07:00."),
    ).toBeTruthy();
    expect(groupsInCache(client).map((g) => g.senderName)).toContain("Daily Digest");
  });
});

describe("useItemActions", () => {
  it("adds the sender to Always keep, then keeps the group", async () => {
    const { state, byName } = setup();
    const north = byName("Northwind Deals");
    await act(async () => {
      await items?.alwaysKeep(north, north.sender, asOf);
    });
    expect(state.requests.find((r) => r.route === "patchSender")?.body).toEqual({
      entry: "promo@northwind.example",
      list: "allow",
    });
    expect(screen.getByText("Northwind Deals is on your Always keep list. 6 emails kept.")).toBeTruthy();
  });

  it("shows no Undo after Always keep", async () => {
    const { byName } = setup();
    const north = byName("Northwind Deals");
    await act(async () => {
      await items?.alwaysKeep(north, north.sender, asOf);
    });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });

  it("adds the sender to Always OK to trash without Undo", async () => {
    const { byName } = setup();
    await act(async () => {
      await items?.alwaysTrash(byName("Daily Digest"));
    });
    expect(
      screen.getByText(
        "Daily Digest is on your Always OK to trash list. Future emails from it skip the confidence check.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("approves one email when the choice matches its suggestion", async () => {
    const { state, client, byName } = setup();
    const north = byName("Northwind Deals");
    const item = toSuggestionItem(
      state,
      pendingItems(state).find((i) => i.id === 1000)!,
    );
    await act(async () => {
      await items?.itemAction(north, item, "delete");
    });
    expect(state.requests.find((r) => r.route === "approve")?.body).toEqual({ ids: [1000] });
    expect(screen.getByText("Moved 1 email to Trash.")).toBeTruthy();
    expect(groupsInCache(client).find((g) => g.key === north.key)?.count).toBe(5);
  });

  it("shows no Undo for a per-email Keep", async () => {
    const { state, byName } = setup();
    const mom = byName("Mom");
    const item = toSuggestionItem(
      state,
      pendingItems(state).find((i) => keyOf(i) === mom.key)!,
    );
    await act(async () => {
      await items?.itemAction(mom, item, "keep");
    });
    expect(screen.getByText("Kept 1 email.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
  });
});
