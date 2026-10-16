import { act, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNewSuggestions } from "../../../../src/web/pages/review/use-new-suggestions.ts";
import {
  useReviewHotkeys,
  type ReviewHotkeyHandlers,
} from "../../../../src/web/pages/review/use-review-hotkeys.ts";
import { useReviewParams } from "../../../../src/web/pages/review/use-review-params.ts";
import { useScanNow } from "../../../../src/web/pages/review/use-scan-now.ts";
import { HotkeysProvider } from "../../../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "../../helpers/core.tsx";
import { createFakeApiState, summaryOf } from "../../msw/fake-api.ts";
import { ACC_GMAIL, iso, T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

afterEach(() => vi.useRealTimers());

describe("useNewSuggestions (UI spec 6.6)", () => {
  it("shows the pill only when a later summary differs from the snapshot", () => {
    const base = summaryOf(createFakeApiState());
    const { result, rerender } = renderHook(({ s, at }) => useNewSuggestions(s, at), {
      initialProps: { s: base, at: 1 },
    });
    expect(result.current.show).toBe(false);
    const fewer = {
      ...base,
      pending: { ...base.pending, total: base.pending.total - 6 },
      groups: base.groups - 1,
    };
    act(() => result.current.applyDelta(-6, -1));
    rerender({ s: fewer, at: 1 });
    expect(result.current.show).toBe(false);
    rerender({ s: { ...fewer, pending: { ...fewer.pending, total: fewer.pending.total + 25 } }, at: 1 });
    expect(result.current.show).toBe(true);
    rerender({ s: { ...fewer, pending: { ...fewer.pending, total: fewer.pending.total + 25 } }, at: 2 });
    expect(result.current.show).toBe(false);
  });
});

describe("useReviewParams", () => {
  it("reads defaults and writes only non-default values", async () => {
    installFakeApi();
    let params: ReturnType<typeof useReviewParams> | null = null;
    function Grab() {
      params = useReviewParams();
      return null;
    }
    const { router } = renderWithCore(<Grab />, { path: "/review?tab=trash&sort=count_desc&account=acc_1" });
    expect(params).toMatchObject({ tab: "trash", sort: "count_desc", accountId: "acc_1", groupKey: null });
    act(() => params?.update({ tab: "all", sort: "confidence_desc", group: "k1" }));
    expect(router.state.location.search).toBe("?account=acc_1&group=k1");
  });
});

describe("useReviewHotkeys", () => {
  it("maps the Review keys to handlers", async () => {
    installFakeApi();
    const h: ReviewHotkeyHandlers = {
      move: vi.fn(),
      toggleActive: vi.fn(),
      rangeToActive: vi.fn(),
      act: vi.fn(),
      cleanUp: vi.fn(),
      tab: vi.fn(),
      escape: vi.fn(),
    };
    function Grab() {
      useReviewHotkeys(h, true);
      return <input aria-label="Filter" />;
    }
    const { user } = renderWithCore(
      <HotkeysProvider>
        <Grab />
      </HotkeysProvider>,
    );
    await user.keyboard("jk{ArrowDown}x{Shift>}X{/Shift}tae3{Escape}");
    expect((h.move as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m)).toEqual(["next", "prev", "next"]);
    expect(
      [h.toggleActive, h.rangeToActive, h.escape].map(
        (f) => (f as ReturnType<typeof vi.fn>).mock.calls.length,
      ),
    ).toEqual([1, 1, 1]);
    expect((h.act as ReturnType<typeof vi.fn>).mock.calls.map(([a]) => a)).toEqual([
      "delete",
      "archive",
      "keep",
    ]);
    expect(h.tab).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("textbox", { name: "Filter" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(h.cleanUp).toHaveBeenCalledOnce();
  });
});

describe("useScanNow", () => {
  function setup(accountId?: string) {
    let scan: ReturnType<typeof useScanNow> | null = null;
    const state = installFakeApi((s) => {
      s.scanDecided = 25;
    });
    function Grab() {
      scan = useScanNow(state.accounts, accountId);
      return null;
    }
    renderWithCore(<Grab />);
    return { state, run: () => scan?.run() ?? Promise.resolve() };
  }

  it("scans each active account and sums new emails", async () => {
    const { state, run } = setup();
    await act(run);
    expect(state.requests.filter((r) => r.route === "scan")).toHaveLength(2);
    expect(screen.getByText("Scan finished. 50 new emails sorted.")).toBeTruthy();
  });

  it("explains a busy account", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const { state, run } = setup(ACC_GMAIL);
    state.failures.scan = { status: 409, code: "account_busy", times: 1, retryAt: iso(T0 + 2 * 60_000) };
    await act(run);
    expect(
      screen.getByText("A scan is already running for you@example.com. Try again in 2 min."),
    ).toBeTruthy();
  });

  it("stops at the free-tier limit", async () => {
    const { state, run } = setup();
    state.failures.scan = { status: 429, code: "budget_exhausted", times: 1 };
    await act(run);
    expect(state.requests.filter((r) => r.route === "scan")).toHaveLength(1);
    expect(
      screen.getByText(/^Today's free-tier limit is reached\. Scanning resumes after \d\d:\d\d\.$/),
    ).toBeTruthy();
  });

  it("says when a backed-off account retries and when it needs to reconnect", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const { state, run } = setup(ACC_GMAIL);
    state.failures.scan = { status: 409, code: "account_inactive", times: 1, retryAt: iso(T0 + 10 * 60_000) };
    await act(run);
    expect(
      screen.getByText(/^you@example\.com is retrying after a problem\. Next try at \d\d:\d\d\.$/),
    ).toBeTruthy();
    state.failures.scan = { status: 409, code: "account_inactive", times: 1 };
    await act(run);
    expect(screen.getByText("you@example.com is paused.")).toBeTruthy();
  });
});
