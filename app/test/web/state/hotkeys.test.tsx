import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSequenceHint } from "../../../src/web/components/shell/GSequenceHint.tsx";
import { ShortcutHelpDialog } from "../../../src/web/components/shell/ShortcutHelpDialog.tsx";
import { isTypingTarget, matchesCombo } from "../../../src/web/state/hotkeys-core.ts";
import { HotkeysProvider, useHotkeys } from "../../../src/web/state/HotkeysProvider.tsx";
import { useUndoStack, type UndoStackApi } from "../../../src/web/state/UndoStackProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { installFakeApi } from "../msw/handlers.ts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("hotkeys core", () => {
  it("matches combos per platform and rejects extra modifiers", () => {
    expect(matchesCombo(key({ key: "Enter", ctrlKey: true }), "mod+enter", "other")).toBe(true);
    expect(matchesCombo(key({ key: "Enter", metaKey: true }), "mod+enter", "mac")).toBe(true);
    expect(matchesCombo(key({ key: "Enter", metaKey: true }), "mod+enter", "other")).toBe(false);
    expect(matchesCombo(key({ key: "T" }), "t", "other")).toBe(true);
    expect(matchesCombo(key({ key: "t", altKey: true }), "t", "other")).toBe(false);
    expect(matchesCombo(key({ key: "X", shiftKey: true }), "shift+x", "other")).toBe(true);
    expect(matchesCombo(key({ key: "X", shiftKey: true }), "x", "other")).toBe(false);
    expect(matchesCombo(key({ key: "?", shiftKey: true }), "?", "other")).toBe(true);
  });

  it("treats text fields, not checkboxes, as typing targets", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    expect([
      isTypingTarget(text),
      isTypingTarget(box),
      isTypingTarget(document.createElement("textarea")),
    ]).toEqual([true, false, true]);
  });
});

function Bindings({
  review,
  confirm,
}: {
  review: Record<string, () => void>;
  confirm?: Record<string, () => void>;
}) {
  useHotkeys("review", [
    { combo: "t", handler: () => review.t?.() },
    { combo: "a", handler: () => review.a?.() },
    { combo: "j", handler: () => review.j?.(), repeat: true },
    { combo: "escape", handler: () => review.escape?.() },
    { combo: "mod+enter", handler: () => review.cleanup?.(), allowInInputs: true },
  ]);
  useHotkeys("confirm", [{ combo: "escape", handler: () => confirm?.escape?.() }], confirm !== undefined);
  return <input aria-label="Search" />;
}

let stack: UndoStackApi | null = null;
function GrabUndo() {
  stack = useUndoStack();
  return null;
}

function setup(review: Record<string, () => void>, confirm?: Record<string, () => void>) {
  const state = installFakeApi();
  return {
    state,
    ...renderWithCore(
      <HotkeysProvider>
        <GrabUndo />
        <Bindings review={review} {...(confirm ? { confirm } : {})} />
        <GSequenceHint />
        <ShortcutHelpDialog />
      </HotkeysProvider>,
    ),
  };
}

const undoCalls = (state: ReturnType<typeof installFakeApi>) =>
  state.requests.filter((r) => r.route === "undo").length;
const pushUndo = (batchId: number) =>
  act(() =>
    stack?.notifyWithUndo({ kind: "action", message: `Moved batch ${batchId}.`, batchIds: [batchId] }),
  );

describe("HotkeysProvider", () => {
  afterEach(() => vi.useRealTimers());

  it("fires single-key shortcuts outside fields and mod+Enter everywhere", async () => {
    const review = { t: vi.fn(), cleanup: vi.fn() };
    const { user } = setup(review);
    await user.keyboard("t");
    expect(review.t).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("textbox", { name: "Search" }));
    await user.keyboard("t");
    expect(review.t).toHaveBeenCalledOnce();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(review.cleanup).toHaveBeenCalledOnce();
  });

  it("gives Esc to the highest-priority scope", async () => {
    const review = { escape: vi.fn() };
    const confirm = { escape: vi.fn() };
    const { user } = setup(review, confirm);
    await user.keyboard("{Escape}");
    expect(confirm.escape).toHaveBeenCalledOnce();
    expect(review.escape).not.toHaveBeenCalled();
  });

  it("runs G sequences, where A means Activity and not Archive, and shows the hint after 400 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const review = { a: vi.fn() };
    const { router, user } = setup(review);
    await user.keyboard("g");
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("status").textContent).toBe(
      "Go to: R Review · A Activity · I Insights · U Rules · C Accounts",
    );
    await user.keyboard("a");
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
    expect(review.a).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the help dialog with ? and turns single-key shortcuts off", async () => {
    const review = { t: vi.fn(), escape: vi.fn() };
    const { user } = setup(review);
    await user.keyboard("?");
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByText("Shortcuts are off while you type in a field.")).toBeTruthy();
    expect(screen.getByText("tabs").parentElement?.textContent).toBe("1to5tabs");
    await user.click(screen.getByRole("switch", { name: "Use single-key shortcuts" }));
    expect(window.localStorage.getItem("clearbox.singleKeys")).toBe("off");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("t");
    expect(review.t).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(review.escape).toHaveBeenCalledOnce();
  });

  it("acts once when an action key is held, but repeats navigation keys", async () => {
    const review = { t: vi.fn(), j: vi.fn() };
    const { user } = setup(review);
    await user.keyboard("{t>4/}");
    expect(review.t).toHaveBeenCalledOnce();
    await user.keyboard("{j>4/}");
    expect(review.j).toHaveBeenCalledTimes(4);
  });

  it("undoes once with mod+Z, even when held, and never inside a text field", async () => {
    const { state, user } = setup({});
    pushUndo(2);
    pushUndo(3);
    await user.keyboard("{Control>}{z>3/}{/Control}");
    await screen.findByText(/^Restored [\d,]+ emails? to your inbox\.$/);
    expect(undoCalls(state)).toBe(1);
    await user.click(screen.getByRole("textbox", { name: "Search" }));
    await user.keyboard("{Control>}z{/Control}");
    expect(undoCalls(state)).toBe(1);
  });

  it("runs undoLatest exactly once for a single mod+Z", async () => {
    const { state, user } = setup({});
    pushUndo(2);
    pushUndo(3);
    await user.keyboard("{Control>}z{/Control}");
    await screen.findByText(/^Restored [\d,]+ emails? to your inbox\.$/);
    expect(state.requests.filter((r) => r.route === "undo").map((r) => r.url.pathname)).toEqual([
      "/api/batches/3/undo",
    ]);
  });
});
