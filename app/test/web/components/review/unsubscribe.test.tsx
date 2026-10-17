import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  UnsubscribeSection,
  type UnsubscribeSectionProps,
} from "../../../../src/web/components/review/UnsubscribeSection.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";

function props(over: Partial<UnsubscribeSectionProps> = {}): UnsubscribeSectionProps {
  return {
    name: "Northwind Deals",
    count: 6,
    state: { oneClick: true, unsubscribedAt: null },
    phase: "idle",
    running: null,
    disabled: false,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
}

describe("UnsubscribeSection (UI spec 4.14a)", () => {
  it("renders nothing without one-click and without a past unsubscribe", () => {
    const { container } = render(
      <UnsubscribeSection {...props({ state: { oneClick: false, unsubscribedAt: null } })} />,
    );
    expect(container.innerHTML).toBe("");
    const none = render(<UnsubscribeSection {...props({ state: null })} />);
    expect(none.container.innerHTML).toBe("");
  });

  it("offers Unsubscribe when the newest email supports one-click", async () => {
    const p = props();
    render(<UnsubscribeSection {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Unsubscribe from Northwind Deals" }));
    expect(p.onStart).toHaveBeenCalledOnce();
  });

  it("shows the unsubscribe date, and offers it again only while one-click is still offered", () => {
    const at = "2026-10-13T08:00:00.000Z";
    render(<UnsubscribeSection {...props({ state: { oneClick: false, unsubscribedAt: at } })} />);
    expect(screen.getByText("Unsubscribed on 13 Oct")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    render(<UnsubscribeSection {...props({ state: { oneClick: true, unsubscribedAt: at } })} />);
    expect(screen.getByRole("button", { name: "Unsubscribe from Northwind Deals" }).textContent).toBe(
      "Unsubscribe again",
    );
  });

  it("confirms inline with both paths, says it cannot be undone, and focuses the first choice", async () => {
    const p = props({ phase: "confirming" });
    const { container } = render(<UnsubscribeSection {...p} />);
    const group = screen.getByRole("group", { name: "Unsubscribe from Northwind Deals?" });
    expect(group.textContent).toContain("Unsubscribing can't be undone.");
    expect(group.textContent).toContain("Moving 6 emails to Trash can be undone for 24 hours.");
    const both = screen.getByRole("button", { name: "Trash 6 and unsubscribe" });
    expect(document.activeElement).toBe(both);
    await userEvent.click(both);
    await userEvent.click(screen.getByRole("button", { name: "Unsubscribe only" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onConfirm).toHaveBeenNthCalledWith(1, "trash");
    expect(p.onConfirm).toHaveBeenNthCalledWith(2, "only");
    expect(p.onCancel).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("shows progress on the chosen button and locks the others while running", async () => {
    const p = props({ phase: "running", running: "only" });
    render(<UnsubscribeSection {...p} />);
    expect(screen.getByRole("button", { name: "Unsubscribing…" }).getAttribute("aria-busy")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Trash 6 and unsubscribe" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onConfirm).not.toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("soft-disables the start button when actions are unavailable", async () => {
    const p = props({ disabled: true });
    render(<UnsubscribeSection {...p} />);
    const button = screen.getByRole("button", { name: "Unsubscribe from Northwind Deals" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button);
    expect(p.onStart).not.toHaveBeenCalled();
  });
});
