import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "../../../../src/web/components/ui/Banner.tsx";
import { Button } from "../../../../src/web/components/ui/Button.tsx";
import { ChipInput } from "../../../../src/web/components/ui/ChipInput.tsx";
import { Dialog } from "../../../../src/web/components/ui/Dialog.tsx";
import { EmptyState } from "../../../../src/web/components/ui/EmptyState.tsx";
import { Menu } from "../../../../src/web/components/ui/Menu.tsx";
import { ProgressBar } from "../../../../src/web/components/ui/ProgressBar.tsx";
import { Table } from "../../../../src/web/components/ui/Table.tsx";
import { Tabs } from "../../../../src/web/components/ui/Tabs.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";

describe("Banner and EmptyState", () => {
  it("announces late error banners and runs actions", async () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Banner
        tone="error"
        title="Clearbox can't use the AI model."
        body="New emails are marked Check until this is fixed."
        actions={[{ label: "Open setup guide", onClick }]}
        dismissible
        onDismiss={onDismiss}
        announce
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Clearbox can't use the AI model. New emails are marked Check",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open setup guide" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss: Clearbox can't use the AI model." }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders an empty state heading with its action", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        variant="panel"
        title="Nothing to review"
        body="New mail gets sorted every 30 minutes."
        action={{ label: "Scan now", onClick }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Nothing to review" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Scan now" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("ProgressBar", () => {
  it("exposes determinate values and sets geometry only through --cb-value", () => {
    render(
      <ProgressBar value={0.63} tone="accent" label="Daily writes used" valueText="21,080 of 90,000 (23%)" />,
    );
    const bar = screen.getByRole("progressbar", { name: "Daily writes used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(bar.getAttribute("aria-valuetext")).toBe("21,080 of 90,000 (23%)");
    expect((bar.querySelector(".cb-fill") as HTMLElement).style.getPropertyValue("--cb-value")).toBe("0.63");
  });

  it("omits aria-valuenow when indeterminate", () => {
    render(<ProgressBar value={null} tone="archive" label="Sorting progress" />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });
});

describe("Table", () => {
  const columns = [{ key: "a", header: "Account", render: (r: { a: string }) => r.a }];

  it("renders rows, empty and error states", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <Table
        caption="Accounts"
        columns={columns}
        rows={[{ a: "you@example.com" }]}
        rowKey={(r) => r.a}
        state="ready"
        emptyText="No accounts connected."
      />,
    );
    expect(screen.getByRole("table", { name: "Accounts" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "you@example.com" })).toBeTruthy();
    rerender(
      <Table
        caption="Accounts"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.a}
        state="empty"
        emptyText="No accounts connected."
      />,
    );
    expect(screen.getByText("No accounts connected.")).toBeTruthy();
    rerender(
      <Table
        caption="Accounts"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.a}
        state="error"
        emptyText=""
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Couldn't load this table.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("Tabs", () => {
  it("implements roving focus with automatic activation", async () => {
    function Harness() {
      const [tab, setTab] = useState<"all" | "trash" | "keep">("all");
      return (
        <Tabs
          label="Filter by suggestion"
          value={tab}
          onChange={setTab}
          controls="group-list"
          idPrefix="tab"
          items={[
            { key: "all", label: "All", count: 7 },
            { key: "trash", label: "Trash", count: 3, ariaLabel: "Trash, 3 groups" },
            { key: "keep", label: "Keep", count: 0 },
          ]}
        />
      );
    }
    render(<Harness />);
    const all = screen.getByRole("tab", { name: /^All/ });
    expect(all.getAttribute("aria-selected")).toBe("true");
    all.focus();
    await userEvent.keyboard("{ArrowRight}");
    const trash = screen.getByRole("tab", { name: "Trash, 3 groups" });
    expect(trash.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(trash);
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /^Keep/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Home}");
    expect(all.getAttribute("tabindex")).toBe("0");
  });
});

describe("Menu and Dialog", () => {
  it("opens, moves with arrows, selects and returns focus", async () => {
    const onCopy = vi.fn();
    render(
      <Menu
        label="More actions"
        align="end"
        items={[
          { id: "deny", label: "Always OK to trash Northwind Deals", onSelect: () => undefined },
          { id: "copy", label: "Copy sender address", icon: "copy", onSelect: onCopy },
        ]}
        renderTrigger={(p) => <Button {...p} variant="ghost" icon="more" aria-label="More actions" />}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Always OK to trash Northwind Deals");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders a modal dialog with a close button", async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Keyboard shortcuts">
        <p>Shortcuts are off while you type in a field.</p>
      </Dialog>,
    );
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ChipInput", () => {
  function Harness() {
    const [values, setValues] = useState(["@bank.example"]);
    return (
      <>
        <h3 id="allow-title">Always keep these senders</h3>
        <ChipInput
          labelledBy="allow-title"
          listName="Always keep"
          values={values}
          placeholder="Add sender or @domain"
          max={1000}
          validate={(raw) =>
            /^(@|[^@\s]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw.trim().toLowerCase())
              ? { ok: true, value: raw.trim().toLowerCase() }
              : { ok: false, error: "Use name@domain.com or @domain.com." }
          }
          onAdd={(v) => setValues((xs) => [...xs, v])}
          onRemove={(v) => setValues((xs) => xs.filter((x) => x !== v))}
        />
      </>
    );
  }

  it("adds on Enter and comma, validates, rejects duplicates and removes", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Always keep these senders" });
    await userEvent.type(input, "Mom@Family.example{Enter}");
    await userEvent.type(input, "nope,");
    expect(screen.getByText("Use name@domain.com or @domain.com.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(input);
    await userEvent.type(input, "@bank.example{Enter}");
    expect(screen.getByText("This entry is already in the list.")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Always keep" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.firstChild?.textContent),
    ).toEqual(["@bank.example", "mom@family.example"]);
    await userEvent.clear(input);
    await userEvent.keyboard("{Backspace}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove mom@family.example from Always keep" }),
    );
    await userEvent.keyboard("{Enter}");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await expectNoA11yViolations();
  });
});
