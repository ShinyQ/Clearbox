import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueSummary, SenderGroup } from "../../../../src/shared/api.ts";
import { qk } from "../../../../src/web/api/keys.ts";
import { groupsInCache } from "../../../../src/web/pages/review/group-cache.ts";
import { useGroupActions, type GroupActionsApi } from "../../../../src/web/pages/review/use-group-actions.ts";
import { useItemActions } from "../../../../src/web/pages/review/use-item-actions.ts";
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

let actions: GroupActionsApi | null = null;
let items: ReturnType<typeof useItemActions> | null = null;
const calls = { removed: [] as string[][], restored: [] as string[] };

function Harness() {
  const cb = {
    onRemoved: (k: string[]) => calls.removed.push(k),
    onRestored: (k: string) => calls.restored.push(k),
    onDelta: () => undefined,
    errorContext: () => ({ providerLabel: "Gmail", resetTime: "07:00" }),
    accountFor: () => undefined,
  };
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
});
