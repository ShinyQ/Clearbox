import { act, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { FakeApiState } from "../msw/fake-api-state.ts";
import { useUndoStack } from "../../../src/web/state/UndoStackProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

type Stack = ReturnType<typeof useUndoStack>;

function Grab({ onReady }: { onReady: (s: Stack) => void }) {
  onReady(useUndoStack());
  return null;
}

const batch11 = (s: FakeApiState) => {
  s.batches.unshift({
    id: 11,
    kind: "approve",
    createdAt: iso(T0),
    requestedCount: 5,
    executedCount: 5,
    failedCount: 0,
    byAction: { delete: 5, archive: 0, keep: 0 },
    undoable: true,
    undoExpiresAt: iso(T0 + 86_400_000),
    undoneAt: null,
    itemIds: [],
  });
};

describe("UndoStackProvider", () => {
  it("shows Undo, undoes every batch newest first and reports the total", async () => {
    const state = installFakeApi((s) => {
      s.batches.unshift({
        id: 11,
        kind: "approve",
        createdAt: iso(T0),
        requestedCount: 5,
        executedCount: 5,
        failedCount: 0,
        byAction: { delete: 5, archive: 0, keep: 0 },
        undoable: true,
        undoExpiresAt: iso(T0 + 86_400_000),
        undoneAt: null,
        itemIds: [],
      });
    });
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() =>
      stack?.notifyWithUndo({
        kind: "action",
        message: "Moved 1,285 emails from 2 sender groups to Trash.",
        batchIds: [3, 11],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Restored 1,285 emails to your inbox.");
    expect(state.requests.filter((r) => r.route === "undo").map((r) => r.url.pathname)).toEqual([
      "/api/batches/11/undo",
      "/api/batches/3/undo",
    ]);
  });

  it("says nothing needed restoring when undoing a mixed batch whose items were already back", async () => {
    installFakeApi((s) => {
      batch11(s);
      const mixed = s.batches.find((b) => b.id === 11);
      if (mixed) mixed.byAction = { delete: 3, archive: 0, keep: 2 };
    });
    server.use(
      http.post("*/api/batches/11/undo", () =>
        HttpResponse.json({ batchId: 11, results: [], restored: 0, failed: 0, skipped: 5 }),
      ),
    );
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() =>
      stack?.notifyWithUndo({ kind: "action", message: "Done: 3 to Trash, 2 kept.", batchIds: [11] }),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Nothing needed restoring. These emails were already back or untouched.");
    expect(screen.queryByText(/^Restored/)).toBeNull();
  });

  it("shows a plain toast and pushes no entry for a keep-only notice", async () => {
    installFakeApi();
    let stack = null as Stack | null;
    renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() =>
      stack?.notifyWithUndo({ kind: "action", message: "Kept 5 emails.", batchIds: [11], keepOnly: true }),
    );
    expect(screen.getByText("Kept 5 emails.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(stack?.size).toBe(0);
    await act(async () => {
      await stack?.undoLatest();
    });
    expect(
      screen.getByText(
        "Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours.",
      ),
    ).toBeTruthy();
  });

  it("reports an expired undo", async () => {
    installFakeApi();
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() =>
      stack?.notifyWithUndo({
        kind: "cleanup",
        message: "14 emails cleaned up from 4 sender groups",
        batchIds: [1],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undo is no longer available for this Clean up (24 hours passed).");
  });

  it("explains an empty stack and links to Activity", async () => {
    installFakeApi();
    let stack: Stack | null = null;
    const { router, user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    await act(() => stack?.undoLatest() ?? Promise.resolve());
    expect(
      screen.getByText(
        "Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
  });

  it("reports a partial result when a later batch fails after an earlier one restored", async () => {
    installFakeApi((s) => {
      batch11(s);
      const older = s.batches.find((b) => b.id === 3);
      if (older) older.undoable = false;
    });
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() => stack?.notifyWithUndo({ kind: "cleanup", message: "Cleaned up.", batchIds: [3, 11] }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText(
      "Restored 5 emails. Some could not be restored and are still in Trash or Archive.",
    );
    expect(screen.queryByText(/Nothing was changed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("uses the network copy without a retry when nothing was restored", async () => {
    installFakeApi((s) => {
      s.failures.undo = { status: 0, code: "network", times: 1 };
    });
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() => stack?.notifyWithUndo({ kind: "action", message: "Moved.", batchIds: [3] }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Couldn't reach Clearbox. Check your connection and try again.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("reuses the originating toast when undoing with the shortcut", async () => {
    installFakeApi();
    let stack: Stack | null = null;
    renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    const toasts = () => document.querySelectorAll(".cb-toast");
    act(() => stack?.notifyWithUndo({ kind: "action", message: "Moved 6 emails.", batchIds: [3] }));
    expect(toasts()).toHaveLength(1);
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = stack?.undoLatest() ?? Promise.resolve();
    });
    expect(screen.getByText("Undoing…")).toBeTruthy();
    expect(screen.queryByText("Moved 6 emails.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(toasts()).toHaveLength(1);
    await act(() => pending);
    await screen.findByText(/^Restored [\d,]+ emails? to your inbox\.$/);
    expect(toasts()).toHaveLength(1);
  });
});
