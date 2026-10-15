import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http } from "msw";
import { describe, expect, it } from "vitest";
import { qk } from "../../../src/web/api/keys.ts";
import { usePatchAccount } from "../../../src/web/api/mutations.ts";
import { accountsInterval, flattenGroups, useAccounts, useGroups } from "../../../src/web/api/queries.ts";
import type { AccountsResponse } from "../../../src/shared/api.ts";
import { createTestQueryClient, queryWrapper } from "../helpers/query.tsx";
import { ACC_GMAIL, T0, makeAccount, makeGroupItems, makeSync } from "../msw/fixtures.ts";
import { errorResponse, installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

describe("accountsInterval (UI spec 6.7)", () => {
  it("polls every 15 s while any account is busy, else every 60 s", () => {
    expect(accountsInterval([makeAccount()], false, T0)).toBe(60_000);
    expect(accountsInterval([makeAccount({ sync: makeSync({ backfillDone: false }) })], false, T0)).toBe(
      15_000,
    );
    expect(accountsInterval([makeAccount({ sync: makeSync({ awaitingModelCount: 3 }) })], false, T0)).toBe(
      15_000,
    );
    expect(accountsInterval([makeAccount()], true, T0)).toBe(15_000);
  });
});

describe("useGroups", () => {
  it("pages with limit 50 and the server cursor", async () => {
    const state = installFakeApi((s) => {
      s.items = Array.from({ length: 60 }, (_, i) =>
        makeGroupItems(
          {
            accountId: ACC_GMAIL,
            sender: `s${i}@bulk.example`,
            name: null,
            action: "delete",
            confidences: [0.9],
            subjects: ["Hi"],
            reasons: [],
          },
          5000 + i,
        ),
      ).flat();
    });
    const client = createTestQueryClient();
    const { result } = renderHook(() => useGroups({ sort: "confidence_desc" }), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(flattenGroups(result.current.data)).toHaveLength(50);
    expect(result.current.hasNextPage).toBe(true);
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(flattenGroups(result.current.data)).toHaveLength(60));
    expect(
      state.requests.filter((r) => r.route === "groups").map((r) => r.url.searchParams.get("cursor")),
    ).toEqual([null, "50"]);
  });
});

describe("usePatchAccount", () => {
  it("flips paused optimistically and rolls back on error", async () => {
    const state = installFakeApi();
    server.use(
      http.patch("*/api/accounts/:id", async () => {
        await delay(150);
        return errorResponse(500, "internal");
      }),
    );
    const client = createTestQueryClient();
    const wrapper = queryWrapper(client);
    const accounts = renderHook(() => useAccounts(), { wrapper });
    await waitFor(() => expect(accounts.result.current.isSuccess).toBe(true));
    const mutation = renderHook(() => usePatchAccount(), { wrapper });
    // The settle refetch lands before isError flips, so it must return the flipped value and the cache is recorded
    // on every change: only the onError rollback can put false back between the optimistic flip and the refetch.
    state.accounts = state.accounts.map((a) => ({ ...a, paused: true }));
    const seen: boolean[] = [];
    client.getQueryCache().subscribe(() => {
      const paused = client.getQueryData<AccountsResponse>(qk.accounts)?.accounts[0]?.paused;
      if (paused !== undefined && seen.at(-1) !== paused) seen.push(paused);
    });
    act(() => mutation.result.current.mutate({ id: ACC_GMAIL, paused: true }));
    await waitFor(() =>
      expect(client.getQueryData<AccountsResponse>(qk.accounts)?.accounts[0]?.paused).toBe(true),
    );
    await waitFor(() => expect(mutation.result.current.isError).toBe(true));
    expect(seen).toEqual([true, false, true]);
  });
});
