import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SenderGroupList,
  type SenderGroupListProps,
} from "../../../../src/web/components/review/SenderGroupList.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState, deriveGroups, sortGroups } from "../../msw/fake-api.ts";

function props(over: Partial<SenderGroupListProps> = {}): SenderGroupListProps {
  const s = createFakeApiState();
  const groups = sortGroups(deriveGroups(s), "confidence_desc");
  return {
    state: "ready",
    tab: "all",
    groups,
    tau: s.tau,
    accountsById: Object.fromEntries(s.accounts.map((a) => [a.id, a])),
    showAccount: false,
    activeKey: groups[0]?.key ?? null,
    selected: new Set(),
    busyKeys: new Set(),
    exitingKeys: new Set(),
    totalInTab: groups.length,
    hasNextPage: false,
    isFetchingNextPage: false,
    bulkProgress: null,
    platform: "other",
    onActivate: vi.fn(),
    onToggleSelect: vi.fn(),
    onSelectAllLoaded: vi.fn(),
    onSelectAllInTab: vi.fn(),
    onClearSelection: vi.fn(),
    onBulkAction: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onMove: vi.fn(),
    ...over,
  };
}

const rows = () => screen.getAllByRole("row").slice(1);

describe("SenderGroupList", () => {
  it("renders an accessible grid with descriptive row names", async () => {
    const { container } = render(<SenderGroupList {...props()} />);
    const grid = screen.getByRole("grid", { name: "Sender groups, All tab" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Northwind Deals, Trash, 97% Very sure, in Clean up, 6 emails",
      "Contoso Orders, Archive, 92% Sure, in Clean up, 3 emails, protected by a guardrail",
      "Daily Digest, Trash, 90% Sure, in Clean up, 4 emails",
      "Mom, Keep, 90% Sure, not in Clean up, 2 emails",
      "Tailspin Travel, Trash, 85% Likely, left for you, 3 emails",
      "Fabrikam Updates, Archive, 79% Likely, left for you, 4 emails",
      "Build Bot, Check, 50% Unsure, left for you, 5 emails",
    ]);
    expect(rows()[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows()[1]?.getAttribute("tabindex")).toBe("-1");
    expect(within(rows()[1] as HTMLElement).getByText("Protected")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("renders email text as text, never as HTML", () => {
    const p = props();
    const evil = {
      ...p.groups[0]!,
      senderName: "<img src=x onerror=alert(1)>",
      latestSubject: "<b>bold</b>",
    };
    render(<SenderGroupList {...p} groups={[evil]} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("activates on click, toggles with mod and checkbox, ranges with shift", async () => {
    const p = props();
    render(<SenderGroupList {...p} />);
    const user = userEvent.setup();
    await user.click(within(rows()[2] as HTMLElement).getByText("Daily Digest"));
    expect(p.onActivate).toHaveBeenCalledWith(p.groups[2]?.key, { openDetail: true });
    await user.keyboard("{Control>}");
    await user.click(within(rows()[3] as HTMLElement).getByText("Mom"));
    await user.keyboard("{/Control}");
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[3]?.key, { range: false });
    await user.click(screen.getByRole("checkbox", { name: "Select Build Bot" }));
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[6]?.key, { range: false });
    await user.keyboard("{Shift>}");
    await user.click(within(rows()[4] as HTMLElement).getByText("Tailspin Travel"));
    await user.keyboard("{/Shift}");
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[4]?.key, { range: true });
  });

  it("moves with row-focused keys and opens detail with Enter", async () => {
    const p = props();
    render(<SenderGroupList {...p} />);
    (rows()[0] as HTMLElement).focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}{End}{PageUp}{Enter}");
    expect((p.onMove as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m)).toEqual([
      "next",
      "last",
      "pageup",
    ]);
    expect(p.onActivate).toHaveBeenLastCalledWith(p.groups[0]?.key, { openDetail: true, keyboard: true });
  });

  it("replaces the header with the selection toolbar and blocks Approve for Check groups", async () => {
    const p = props();
    const keys = [p.groups[0]!.key, p.groups[6]!.key];
    render(<SenderGroupList {...p} selected={new Set(keys)} />);
    const toolbar = screen.getByRole("toolbar", { name: "Selected groups" });
    expect(within(toolbar).getByText("2 groups selected · 11 emails")).toBeTruthy();
    // One line in the header row from 640px up; the row trims its padding to keep the header height.
    expect(toolbar.classList.contains("sm:flex-nowrap")).toBe(true);
    expect(toolbar.closest("[role='row']")?.classList.contains("py-0.5")).toBe(true);
    expect(
      within(toolbar).getByRole("button", { name: "Approve suggestions" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("Check groups need your choice. Use Trash, Archive or Keep.")).toBeTruthy();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Trash" }));
    expect(p.onBulkAction).toHaveBeenCalledWith("delete");
  });

  it("offers selecting the whole tab when every loaded row is selected", async () => {
    const p = props({ tab: "trash", hasNextPage: true, totalInTab: 318 });
    render(<SenderGroupList {...p} selected={new Set(p.groups.map((g) => g.key))} />);
    expect(screen.getByText("All 7 loaded groups are selected.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Select all 318 in Trash" }));
    expect(p.onSelectAllInTab).toHaveBeenCalledOnce();
  });

  it("has no axe violations with a selection, loading and empty states", async () => {
    const p = props();
    const sel = render(<SenderGroupList {...p} selected={new Set([p.groups[0]!.key, p.groups[6]!.key])} />);
    await expectNoA11yViolations(sel.container);
    sel.unmount();
    const loading = render(<SenderGroupList {...props({ state: "loading", groups: [] })} />);
    await expectNoA11yViolations(loading.container);
    loading.unmount();
    const empty = render(<SenderGroupList {...props({ state: "empty", groups: [] })} />);
    await expectNoA11yViolations(empty.container);
  });

  it("shows the bulk progress line", () => {
    const p = props();
    render(
      <SenderGroupList {...p} selected={new Set([p.groups[0]!.key])} bulkProgress={{ done: 2, total: 3 }} />,
    );
    expect(screen.getByText("Working on 2 of 3 groups…")).toBeTruthy();
  });

  it.each([
    ["all", "Nothing to review", "New mail gets sorted every 30 minutes."],
    ["trash", "No trash suggestions", "Nothing here looks safe to trash right now."],
    ["keep", "No keep suggestions", "Emails Clearbox thinks you should keep will show up here."],
  ] as const)("shows the %s empty state", (tab, title, body) => {
    render(<SenderGroupList {...props({ state: "empty", tab, groups: [] })} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
  });

  it("shows loading and error states", async () => {
    const p = props({ state: "error", groups: [] });
    const { rerender } = render(<SenderGroupList {...p} />);
    expect(screen.getByRole("heading", { name: "Couldn't load sender groups" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<SenderGroupList {...props({ state: "loading", groups: [] })} />);
    expect(screen.getByRole("grid").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading sender groups")).toBeTruthy();
  });
});
