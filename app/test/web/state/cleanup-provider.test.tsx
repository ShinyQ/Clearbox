import { useQuery } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api as endpoints } from "../../../src/web/api/endpoints.ts";
import { qk } from "../../../src/web/api/keys.ts";
import { CleanupBar } from "../../../src/web/components/review/CleanupBar.tsx";
import { CleanupProvider, useCleanup } from "../../../src/web/state/CleanupProvider.tsx";
import { HotkeysProvider } from "../../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { ACC_GMAIL, makeGroupItems } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import type { FakeApiState } from "../msw/fake-api.ts";

const ctx = {
  pendingTotal: 250,
  accountEmail: null,
  inactiveEmail: null,
  providerLabel: "Gmail",
  resetTime: "07:00",
};

function bigGroup(s: FakeApiState) {
  s.items = makeGroupItems(
    {
      accountId: ACC_GMAIL,
      sender: "promo@northwind.example",
      name: "Northwind Deals",
      action: "delete",
      confidences: Array(250).fill(0.97),
      subjects: ["Sale"],
      reasons: [],
    },
    2000,
  );
}

let api: ReturnType<typeof useCleanup> | null = null;
function Grab() {
  api = useCleanup();
  return <span data-testid="phase">{api.state.machine.phase}</span>;
}

function SummaryWatcher() {
  useQuery({ queryKey: qk.summary(), queryFn: () => endpoints.summary() });
  return null;
}

function setup(mutate: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  const utils = renderWithCore(
    <CleanupProvider sleep={async () => undefined}>
      <HotkeysProvider>
        <Grab />
        <SummaryWatcher />
        <CleanupBar context={ctx} platform="other" />
      </HotkeysProvider>
    </CleanupProvider>,
  );
  return { state, ...utils };
}

const phase = () => screen.getByTestId("phase").textContent;

afterEach(() => vi.restoreAllMocks());

describe("CleanupProvider", () => {
  it("prepares a fresh preview, confirms with Enter, loops until remaining is 0 and offers Undo", async () => {
    const { state, user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    const confirm = await screen.findByRole("button", { name: "Clean up" });
    expect(screen.getByText("Clean up 250 emails in 1 sender group?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await user.keyboard("{Enter}");
    await screen.findByText("250 emails cleaned up from 1 sender group");
    const bodies = state.requests.filter((r) => r.route === "cleanup").map((r) => r.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ threshold: state.tau, actions: ["delete", "archive"] });
    expect(phase()).toBe("idle");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("cancels with Esc", async () => {
    const { user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    await user.keyboard("{Escape}");
    expect(phase()).toBe("idle");
    expect(screen.queryByRole("region", { name: "Clean up" })).toBeNull();
  });

  it("stops after the in-flight call and keeps Undo for what ran", async () => {
    const { user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    act(() => {
      api?.confirm();
      api?.stop();
    });
    await screen.findAllByText("Clean up stopped. 100 emails were cleaned up.");
    expect(screen.getByText("100 emails cleaned up")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(phase()).toBe("idle");
  });

  it("pauses at the budget limit", async () => {
    const { user } = setup((s) => {
      bigGroup(s);
      s.failures.cleanup = { status: 429, code: "budget_exhausted", times: 1 };
    });
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText("Clean up paused at today's free-tier limit. 0 emails were cleaned up.");
    expect(screen.getByText("The other 250 stay in Review. Actions work again after 07:00.")).toBeTruthy();
    expect(phase()).toBe("partial");
  });

  it("keeps Enter on Cancel safe: it cancels instead of starting Clean up", async () => {
    const { state, user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Cancel/ }));
    await user.keyboard("{Enter}");
    expect(phase()).toBe("idle");
    expect(state.requests.some((r) => r.route === "cleanup")).toBe(false);
  });

  it("refreshes the queues after a partial run that moved emails", async () => {
    const { state, user } = setup(bigGroup);
    await waitFor(() => expect(state.requests.filter((r) => r.route === "summary")).toHaveLength(1));
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    act(() => {
      api?.confirm();
      api?.stop();
    });
    await screen.findAllByText("Clean up stopped. 100 emails were cleaned up.");
    await waitFor(() => expect(state.requests.filter((r) => r.route === "summary")).toHaveLength(2));
    expect(phase()).toBe("partial");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("does not refresh the queues after a partial run that moved nothing", async () => {
    const { state, user } = setup((s) => {
      bigGroup(s);
      s.failures.cleanup = { status: 429, code: "budget_exhausted", times: 1 };
    });
    await waitFor(() => expect(state.requests.filter((r) => r.route === "summary")).toHaveLength(1));
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText("Clean up paused at today's free-tier limit. 0 emails were cleaned up.");
    expect(state.requests.filter((r) => r.route === "summary")).toHaveLength(1);
  });

  it("settles in a partial bar when the run throws unexpectedly", async () => {
    const bug = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(endpoints, "cleanup").mockResolvedValue({} as Awaited<ReturnType<typeof endpoints.cleanup>>);
    const { user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText(/Clean up stopped because of an unexpected error/);
    expect(phase()).toBe("partial");
    expect(bug).toHaveBeenCalled();
  });

  it("reports a non-API preview failure and still shows the error toast", async () => {
    const bug = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(endpoints, "cleanupPreview").mockRejectedValue(new TypeError("boom"));
    setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByText("Couldn't prepare Clean up. Nothing was changed.");
    expect(bug).toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("words Confirm all keeps when there is nothing left", async () => {
    setup((s) => {
      s.items = [];
    });
    act(() => api?.start("confirm_keeps"));
    await screen.findByText("Nothing left to confirm. New suggestions appear after the next sort.");
  });

  it("reports item failures with the failure wording", async () => {
    const { user } = setup((s) => {
      bigGroup(s);
      s.failIds = new Set([2000, 2001]);
      s.retryLaterIds = new Set([2002]);
    });
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText("247 emails were cleaned up. 1 is still waiting.");
    expect(
      screen.getByText("The mailbox did not accept more changes right now. Try again in a few minutes."),
    ).toBeTruthy();
  });

  it("tells the owner when nothing is left after a fresh preview", async () => {
    setup((s) => {
      s.items = [];
    });
    act(() => api?.start("cleanup"));
    await screen.findByText("Nothing left to clean up. New suggestions appear after the next sort.");
    expect(phase()).toBe("idle");
  });

  it("confirms all keeps with the keep preview", async () => {
    const { state, user } = setup(() => undefined);
    act(() => api?.start("confirm_keeps"));
    await screen.findByText("Mark 2 emails in 1 sender group as Keep?");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Kept 2 emails from 1 sender group. Clearbox will remember.");
    expect(state.requests.find((r) => r.route === "preview")?.url.search).toContain("actions=keep");
    expect(state.requests.find((r) => r.route === "preview")?.url.search).toContain("threshold=0.5");
  });
});
