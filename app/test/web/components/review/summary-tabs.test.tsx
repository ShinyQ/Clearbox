import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionTabs } from "../../../../src/web/components/review/ActionTabs.tsx";
import { SummaryCard, type SummaryCardProps } from "../../../../src/web/components/review/SummaryCard.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState, previewOf, summaryOf } from "../../msw/fake-api.ts";

function props(over: Partial<SummaryCardProps> = {}): SummaryCardProps {
  const s = createFakeApiState();
  const preview = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
  const summary = summaryOf(s);
  return {
    state: "ready",
    preview,
    pendingTotal: summary.pending.total,
    awaitingModel: 0,
    groupsLeft: preview.groupsLeft,
    tau: preview.threshold,
    catchingUp: false,
    cleanupPhase: "idle",
    offline: false,
    platform: "other",
    onCleanUp: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  };
}

describe("SummaryCard", () => {
  it("states exactly what Clean up will do", async () => {
    const p = props();
    const { container } = render(<SummaryCard {...p} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("14 emails are ready to clean up");
    expect(
      screen.getByText("Clearbox is confident about 4 sender groups. 4 groups are left for you to check."),
    ).toBeTruthy();
    const legend = screen.getByRole("list", { name: "Clean up split" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["11 to trash", "3 to archive", "13 to check or keep"]);
    const button = screen.getByRole("button", { name: "Clean up 14" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    await userEvent.click(button);
    expect(p.onCleanUp).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("appends catching up and awaiting model, and falls back to email counts without A2", () => {
    render(<SummaryCard {...props({ catchingUp: true, awaitingModel: 25, groupsLeft: null })} />);
    expect(
      screen.getByText(
        "Clearbox is confident about 4 sender groups. 13 emails are left for you to check. Still sorting older mail. 25 emails are waiting for the AI model.",
      ),
    ).toBeTruthy();
  });

  it("says nothing else needs you when no group is left", () => {
    render(<SummaryCard {...props({ groupsLeft: 0 })} />);
    expect(
      screen.getByText("Clearbox is confident about 4 sender groups. Nothing else needs you."),
    ).toBeTruthy();
  });

  it("explains the nothing-sure state with tau from the preview", () => {
    const p = props({ state: "nothing_sure", tau: 0.88 });
    render(
      <SummaryCard
        {...p}
        preview={
          p.preview
            ? { ...p.preview, count: 0, byAction: { delete: 0, archive: 0, keep: 0 }, threshold: 0.88 }
            : null
        }
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Nothing is sure enough to clean up yet");
    expect(
      screen.getByText("4 groups are left for you to check. Suggestions at 88% or higher go into Clean up."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows preparing, running and offline button states", () => {
    const { rerender } = render(<SummaryCard {...props({ cleanupPhase: "preparing" })} />);
    expect(screen.getByRole("button", { name: "Preparing…" }).getAttribute("aria-busy")).toBe("true");
    rerender(<SummaryCard {...props({ cleanupPhase: "busy" })} />);
    expect(screen.getByRole("button", { name: "Cleaning up…" }).getAttribute("aria-disabled")).toBe("true");
    rerender(<SummaryCard {...props({ offline: true })} />);
    expect(screen.getByRole("button", { name: "Clean up 14" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("You're offline.")).toBeTruthy();
  });

  it("stacks below lg with a full-width button and sizes the skeleton like the ready card", () => {
    const { container, rerender } = render(<SummaryCard {...props()} />);
    const section = container.querySelector("section");
    expect(section?.className).toMatch(/\bflex-col\b.*\blg:flex-row\b/);
    const button = screen.getByRole("button", { name: "Clean up 14" });
    expect(button.className).toContain("w-full lg:w-auto");
    rerender(<SummaryCard {...props({ state: "loading", preview: null })} />);
    const boxes = [...(section?.querySelectorAll("span.flex.items-center") ?? [])].map((b) =>
      [...b.classList].find((c) => c.startsWith("h-")),
    );
    expect(boxes).toEqual(["h-[22px]", "h-[18px]", "h-4"]);
  });

  it("renders loading and error states", async () => {
    const p = props({ state: "error" });
    const { rerender, container } = render(<SummaryCard {...p} />);
    expect(screen.getByRole("heading").textContent).toBe("Couldn't load the Clean up summary");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<SummaryCard {...props({ state: "loading", preview: null })} />);
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ActionTabs", () => {
  it("names tabs with counts, offers Confirm all keeps on Keep, the pill and sort", async () => {
    const onChange = vi.fn();
    const onSortChange = vi.fn();
    const onRefresh = vi.fn();
    const confirm = vi.fn();
    render(
      <ActionTabs
        value="keep"
        counts={{ all: 7, trash: 3, archive: 2, check: 1, keep: 1 }}
        onChange={onChange}
        sort="confidence_desc"
        onSortChange={onSortChange}
        newSuggestions
        onRefresh={onRefresh}
        confirmKeeps={{ onClick: confirm, busy: false }}
      />,
    );
    expect(screen.getByRole("tab", { name: "Trash, 3 groups" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Keep, 1 group" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Confirm all keeps" }));
    await userEvent.click(screen.getByRole("button", { name: "New suggestions · Refresh" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort groups" }), "count_desc");
    expect([confirm.mock.calls.length, onRefresh.mock.calls.length]).toEqual([1, 1]);
    expect(onSortChange).toHaveBeenCalledWith("count_desc");
  });
});
