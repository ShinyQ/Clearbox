import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnnounce } from "../../../src/web/state/LiveAnnouncer.tsx";
import { addToast, defaultDuration, type ToastItem } from "../../../src/web/state/toast-queue.ts";
import { useToast, type ToastApi } from "../../../src/web/state/ToastProvider.tsx";
import { announcements, renderWithCore } from "../helpers/core.tsx";

const item = (id: string, kind: ToastItem["kind"], dedupeKey?: string): ToastItem => ({
  id,
  kind,
  message: id,
  createdAt: 0,
  ...(dedupeKey ? { dedupeKey } : {}),
});

describe("toast queue rules (UI spec 6.8)", () => {
  it("keeps at most 3 and drops the oldest non-error first", () => {
    const list = [item("e1", "error"), item("s1", "success"), item("i1", "info")];
    expect(addToast(list, item("s2", "success")).map((t) => t.id)).toEqual(["e1", "i1", "s2"]);
  });

  it("drops the oldest error when all 3 are errors", () => {
    const list = [item("e1", "error"), item("e2", "error"), item("e3", "error")];
    expect(addToast(list, item("s1", "success")).map((t) => t.id)).toEqual(["e2", "e3", "s1"]);
  });

  it("replaces a toast with the same dedupe key in place", () => {
    const list = [item("a", "info", "online"), item("b", "success")];
    expect(
      addToast(list, { ...item("a", "info", "online"), message: "Back online." }).map((t) => t.message),
    ).toEqual(["Back online.", "b"]);
  });

  it("uses 8 s for success, 5 s for info and keeps errors", () => {
    expect([
      defaultDuration(item("a", "success")),
      defaultDuration(item("b", "info")),
      defaultDuration(item("c", "error")),
    ]).toEqual([8000, 5000, null]);
  });
});

describe("ToastProvider and region", () => {
  afterEach(() => vi.useRealTimers());

  function Grab({ onReady }: { onReady: (api: ToastApi, announce: (t: string) => void) => void }) {
    onReady(useToast(), useAnnounce());
    return null;
  }

  it("renders polite toasts with the undo hint and errors as alerts, then expires success after 8 s", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api: ToastApi | null = null;
    renderWithCore(<Grab onReady={(a) => (api = a)} />);
    act(() => {
      api?.show({
        kind: "success",
        message: "Moved 6 emails from Northwind Deals to Trash.",
        action: { label: "Undo", shortcut: "mod+z", onAction: () => undefined },
      });
      api?.show({ kind: "error", message: "Something went wrong. Nothing was changed." });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.querySelector("[aria-live='polite']")?.textContent).toContain("Press Control Z to undo");
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong. Nothing was changed.");
    act(() => vi.advanceTimersByTime(8_000 + 250));
    expect(screen.queryByText("Moved 6 emails from Northwind Deals to Trash.")).toBeNull();
    expect(screen.getByText("Something went wrong. Nothing was changed.")).toBeTruthy();
  });

  it("shows an updated toast again when it is no longer in the queue", () => {
    let api: ToastApi | null = null;
    renderWithCore(<Grab onReady={(a) => (api = a)} />);
    act(() => api?.update("gone", { kind: "success", message: "Restored 3 emails to your inbox." }));
    expect(screen.getByText("Restored 3 emails to your inbox.")).toBeTruthy();
  });

  it("resumes the countdown after the focused Undo button disappears", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api: ToastApi | null = null;
    renderWithCore(<Grab onReady={(a) => (api = a)} />);
    let id = "";
    act(() => {
      id =
        api?.show({
          kind: "success",
          message: "Moved.",
          action: { label: "Undo", shortcut: "mod+z", onAction: () => undefined },
        }) ?? "";
    });
    const button = screen.getByRole("button", { name: "Undo" });
    act(() => button.focus());
    act(() => api?.update(id, { kind: "info", message: "Undoing…", busy: true, action: undefined }));
    act(() => api?.update(id, { kind: "success", message: "Restored.", busy: false }));
    act(() => vi.advanceTimersByTime(8_000 + 250));
    expect(screen.queryByText("Restored.")).toBeNull();
  });

  it("announces through the live announcer and clears after 1 s", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let announce: (t: string) => void = () => undefined;
    renderWithCore(<Grab onReady={(_a, an) => (announce = an)} />);
    act(() => announce("Clean up started, 14 emails"));
    expect(announcements()).toBe("Clean up started, 14 emails");
    act(() => vi.advanceTimersByTime(1_000));
    expect(announcements()).toBe("");
  });
});
