import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUndoStack } from "../../../src/web/state/UndoStackProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

type Stack = ReturnType<typeof useUndoStack>;

function Grab({ onReady }: { onReady: (s: Stack) => void }) {
  onReady(useUndoStack());
  return null;
}

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
});
