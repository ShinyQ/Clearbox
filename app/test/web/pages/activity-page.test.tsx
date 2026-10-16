import { screen, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as report from "../../../src/web/lib/report.ts";
import { browser } from "../../../src/web/lib/links.ts";
import { ActivityPage } from "../../../src/web/pages/ActivityPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void, path = "/activity") {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<ActivityPage />, { path }) };
}

/** Mirrors the server: the claim stays (batch undone) unless nothing was restored and something failed. */
const undoResponse = (state: FakeApiState, restored: number, failed: number, skipped: number) =>
  server.use(
    http.post("*/api/batches/3/undo", () => {
      if (restored > 0 || failed === 0) {
        const batch = state.batches.find((b) => b.id === 3)!;
        batch.undoable = false;
        batch.undoneAt = iso(state.now);
      }
      return HttpResponse.json({ batchId: 3, results: [], restored, failed, skipped });
    }),
  );

describe("Activity page", () => {
  it("lists activity newest first with undo states", async () => {
    const { container } = setup();
    const table = await screen.findByRole("table", { name: "Activity" });
    expect(
      await within(table).findByRole("cell", { name: "Clean up · 1,284 emails, 371 sender groups" }),
    ).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "Today 09:00" })).toBeTruthy();
    expect(within(table).getByText("Undone")).toBeTruthy();
    expect(within(table).getByText("Undo expired")).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Open Rules" }).getAttribute("href")).toBe("/rules");
    expect(screen.getByText("Undo is available for 24 hours")).toBeTruthy();
    expect(document.title).toBe("Activity · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("shows no Undo for a keep-only batch even though the server reports it undoable", async () => {
    setup((s) => {
      s.batches.unshift({
        id: 30,
        kind: "approve",
        createdAt: iso(T0 - 30 * 60_000),
        requestedCount: 5,
        executedCount: 5,
        failedCount: 0,
        byAction: { delete: 0, archive: 0, keep: 5 },
        undoable: true,
        undoExpiresAt: iso(T0 + 23 * 3_600_000),
        undoneAt: null,
        itemIds: [],
      });
      s.activity.unshift({
        id: 30,
        ts: iso(T0 - 30 * 60_000),
        kind: "approve",
        accountId: null,
        batchId: 30,
        count: 5,
        result: { executed: 5, failed: 0, skipped: 0, retryLater: 0, delete: 0, archive: 0, keep: 5 },
      });
    });
    const table = await screen.findByRole("table", { name: "Activity" });
    const keepRow = (await within(table).findByRole("cell", { name: "Keep · 5 emails" })).closest("tr")!;
    expect(within(keepRow).queryByRole("button")).toBeNull();
    expect(within(keepRow).queryByText("Undone")).toBeNull();
    expect(within(keepRow).queryByText("Undo expired")).toBeNull();
    expect(within(table).getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("undoes a batch and shows the result", async () => {
    const { state, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1,280 emails to your inbox.")).toBeTruthy();
    expect(state.requests.some((r) => r.url.pathname === "/api/batches/3/undo")).toBe(true);
    expect(await screen.findAllByText("Undone")).toHaveLength(2);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe("Undone");
  });

  it("recovers when refreshing after Undo fails", async () => {
    const reportSpy = vi.spyOn(report, "reportBug").mockImplementation(() => undefined);
    const { user } = setup();
    const button = await screen.findByRole("button", { name: "Undo" });
    vi.spyOn(QueryClient.prototype, "invalidateQueries").mockRejectedValue(new Error("refresh failed"));
    await user.click(button);
    await screen.findByText("Restored 1,280 emails to your inbox.");
    await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(reportSpy).toHaveBeenCalledWith("Refreshing after undo failed", expect.any(Error));
    vi.restoreAllMocks();
  });

  it("marks an expired undo", async () => {
    const { user } = setup((s) => {
      s.failures.undo = { status: 410, code: "undo_expired", times: 1 };
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("Undo is no longer available for this action (24 hours passed)."),
    ).toBeTruthy();
    expect(screen.getAllByText("Undo expired")).toHaveLength(2);
  });

  it("reports a partly restored undo and leaves the row final", async () => {
    const { state, user } = setup();
    undoResponse(state, 900, 380, 0);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 900 emails. 380 could not be restored.")).toBeTruthy();
    expect(await screen.findAllByText("Undone")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("explains an undo that restored nothing and can be tried again", async () => {
    const { state, user } = setup();
    undoResponse(state, 0, 12, 0);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("Nothing could be restored and nothing was changed. You can try Undo again."),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("explains an undo with nothing to restore", async () => {
    const { state, user } = setup();
    undoResponse(state, 0, 0, 40);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("Nothing needed restoring. These emails were already back or untouched."),
    ).toBeTruthy();
    expect(await screen.findAllByText("Undone")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows a network error and keeps Undo available", async () => {
    const { user } = setup((s) => {
      s.failures.undo = { status: 0, code: "network", times: 1 };
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("Couldn't reach Clearbox. Check your connection and try again."),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("offers Reconnect only while the account needs it", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { user } = setup((s) => {
      s.accounts[1] = { ...s.accounts[1]!, status: "needs_reauth" };
    });
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/accounts");
    expect(assign).toHaveBeenCalledWith("/oauth/microsoft/start?loginHint=you%40example.net");
  });

  it("filters by account and keeps the selection in the URL", async () => {
    const { user, router } = setup();
    await screen.findByRole("option", { name: "you@example.net" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Account" }), "you@example.net");
    expect(router.state.location.search).toBe("?account=acc_0000000000000002");
    expect(await screen.findByRole("cell", { name: "Needs reconnect · you@example.net" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: /^Clean up/ })).toBeNull();
  });

  it("shows the empty state", async () => {
    setup((s) => void (s.activity = []));
    expect(
      await screen.findByText("Nothing yet. Actions you take and nightly maintenance appear here."),
    ).toBeTruthy();
  });

  it("offers a retry when loading fails", async () => {
    const { user } = setup((s) => {
      s.failures.activity = { status: 500, code: "internal", times: 2 };
    });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("cell", { name: "Today 09:00" })).toBeTruthy();
  });

  it("pages with Load more", async () => {
    const { user } = setup((s) => {
      s.activity = Array.from({ length: 60 }, (_, i) => ({
        id: 100 - i,
        ts: iso(T0 - i * 60_000),
        kind: "purge" as const,
        accountId: null,
        batchId: null,
        count: i + 1,
        result: {},
      }));
    });
    await screen.findByRole("cell", { name: "Nightly cleanup · 1 old record removed" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("cell", { name: "Nightly cleanup · 60 old records removed" }),
    ).toBeTruthy();
  });
});
