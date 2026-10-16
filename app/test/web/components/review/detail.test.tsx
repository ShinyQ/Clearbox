import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SenderGroup, SuggestionItem } from "../../../../src/shared/api.ts";
import { DetailPanel, type DetailPanelProps } from "../../../../src/web/components/review/DetailPanel.tsx";
import { safeDeepLink } from "../../../../src/web/components/review/EmailPreviewList.tsx";
import { HotkeysProvider } from "../../../../src/web/state/HotkeysProvider.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { renderWithCore } from "../../helpers/core.tsx";
import {
  createFakeApiState,
  deriveGroups,
  keyOf,
  pendingItems,
  toSuggestionItem,
} from "../../msw/fake-api.ts";
import { T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

const s = createFakeApiState();
const byName = (name: string): SenderGroup => deriveGroups(s).find((g) => g.senderName === name)!;
const itemsOf = (g: SenderGroup): SuggestionItem[] =>
  pendingItems(s)
    .filter((i) => keyOf(i) === g.key)
    .sort((a, b) => b.confidence - a.confidence)
    .map((i) => toSuggestionItem(s, i));

function props(group: SenderGroup, over: Partial<DetailPanelProps> = {}): DetailPanelProps {
  return {
    mode: "inline",
    open: true,
    group,
    items: itemsOf(group),
    detailState: "ready",
    hasMoreItems: false,
    loadingMoreItems: false,
    tau: s.tau,
    account: s.accounts.find((a) => a.id === group.accountId) ?? null,
    busyAction: null,
    busyItemIds: new Set(),
    now: T0,
    platform: "other",
    onAction: vi.fn(),
    onAlwaysKeep: vi.fn(),
    onAlwaysTrash: vi.fn(),
    onCopyAddress: vi.fn(),
    onItemAction: vi.fn(),
    onLoadMoreItems: vi.fn(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onReconnect: vi.fn(),
    ...over,
  };
}

describe("DetailPanel", () => {
  it("shows verdict, confidence, membership, reasons and Trash actions", async () => {
    const p = props(byName("Northwind Deals"));
    const { container } = render(<DetailPanel {...p} />);
    const aside = screen.getByRole("complementary", { name: "Northwind Deals" });
    expect(within(aside).getByText("promo@northwind.example · you@example.com")).toBeTruthy();
    expect(within(aside).getByText("Move 6 to Trash")).toBeTruthy();
    expect(within(aside).getByText("All 6 are in Clean up.")).toBeTruthy();
    expect(within(aside).queryByText(/^Range/)).toBeNull();
    expect(within(screen.getByRole("list", { name: "Reasons" })).getAllByRole("listitem")).toHaveLength(3);
    const trash = within(aside).getByRole("button", { name: "Trash 6" });
    expect(trash.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(within(aside).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "Always keep Northwind Deals" })).toBeTruthy();
    await userEvent.click(trash);
    expect(p.onAction).toHaveBeenCalledWith("delete");
    await expectNoA11yViolations(container);
  });

  it("shows the confidence range when it spans at least 5 points", () => {
    render(<DetailPanel {...props(byName("Daily Digest"))} />);
    expect(screen.getByText("Range 88–93% across 4 emails")).toBeTruthy();
  });

  it("uses the Keep and Check variants", () => {
    const { rerender } = render(<DetailPanel {...props(byName("Mom"))} />);
    expect(screen.getByRole("button", { name: "Keep 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Always keep/ })).toBeNull();
    expect(screen.getByText("Keep suggestions are not part of Clean up.")).toBeTruthy();
    rerender(<DetailPanel {...props(byName("Build Bot"))} />);
    expect(screen.getByText("Check 5 yourself")).toBeTruthy();
    expect(screen.getByText("Clearbox needs your call on this group.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trash" })).toBeTruthy();
  });

  it("disables actions while the account needs to reconnect", async () => {
    const g = byName("Northwind Deals");
    const account = { ...s.accounts[0]!, status: "needs_reauth" as const };
    const p = props(g, { account });
    render(<DetailPanel {...p} />);
    expect(screen.getByText("Reconnect you@example.com to act on these emails.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trash 6" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(p.onReconnect).toHaveBeenCalledWith(account);
  });

  it("expands an email as plain text with safe deep links and per-email actions", async () => {
    const g = byName("Northwind Deals");
    const items = itemsOf(g);
    const evil = { ...items[0]!, subject: "<img src=x onerror=alert(1)>" };
    const nosnippet = { ...items[1]!, snippet: null, subject: null };
    const p = props(g, { items: [evil, nosnippet], hasMoreItems: true });
    render(<DetailPanel {...p} />);
    const list = screen.getByRole("list", { name: "Latest emails from Northwind Deals" });
    expect(within(list).getByText("(no subject)")).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: /<img src=x onerror=alert\(1\)>/ }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(`Synthetic preview text for message ${evil.id}.`)).toBeTruthy();
    expect(screen.getByText("Received Thu 15 Oct, 07:00 · 99% Very sure")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open this email in Gmail (new tab)" });
    expect([open.getAttribute("target"), open.getAttribute("rel")]).toEqual([
      "_blank",
      "noopener noreferrer",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Archive this email" }));
    expect(p.onItemAction).toHaveBeenCalledWith(evil.id, "archive");
    expect(screen.getByText("+ 4 more")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(p.onLoadMoreItems).toHaveBeenCalledOnce();
    await userEvent.click(within(list).getByRole("button", { name: /^\(no subject\)/ }));
    expect(screen.getByText("Preview not stored (turned off in Rules).")).toBeTruthy();
  });

  it("allows only Gmail and Outlook https deep links", () => {
    expect(safeDeepLink("https://mail.google.com/mail/u/?authuser=a#all/1")).toBe(
      "https://mail.google.com/mail/u/?authuser=a#all/1",
    );
    expect(safeDeepLink("https://outlook.office.com/mail/id/1")).toBe("https://outlook.office.com/mail/id/1");
    expect(safeDeepLink("javascript:alert(1)")).toBeNull();
    expect(safeDeepLink("https://evil.example/mail.google.com/")).toBeNull();
    expect(safeDeepLink(null)).toBeNull();
  });

  it("renders a non-modal slide-over that Esc closes", async () => {
    installFakeApi();
    const p = props(byName("Contoso Orders"), { mode: "slideover" });
    const { user } = renderWithCore(
      <HotkeysProvider>
        <DetailPanel {...p} />
      </HotkeysProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Contoso Orders" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    await user.keyboard("{Escape}");
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  describe("sheet mode and focus trap", () => {
    const sheet = (g: SenderGroup, over: Partial<DetailPanelProps> = {}) =>
      props(g, { mode: "sheet", ...over });
    const focusables = (dialog: HTMLElement) => [
      ...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    ];
    const mount = (p: DetailPanelProps) =>
      renderWithCore(
        <HotkeysProvider>
          <DetailPanel {...p} />
        </HotkeysProvider>,
      );

    it("renders a modal dialog with Back first in the tab order", async () => {
      installFakeApi();
      const { user } = mount(sheet(byName("Contoso Orders")));
      const dialog = screen.getByRole("dialog", { name: "Contoso Orders" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      await user.tab();
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Back" }));
      expect(focusables(dialog)[0]).toBe(document.activeElement);
    });

    it("wraps Tab from the last control to the first and Shift+Tab back", async () => {
      installFakeApi();
      const { user } = mount(sheet(byName("Contoso Orders")));
      const items = focusables(screen.getByRole("dialog", { name: "Contoso Orders" }));
      items.at(-1)!.focus();
      await user.tab();
      expect(document.activeElement).toBe(items[0]);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(items.at(-1));
    });

    it("pulls focus back inside when Tab is pressed from outside the dialog", () => {
      installFakeApi();
      renderWithCore(
        <HotkeysProvider>
          <button type="button">outside</button>
          <DetailPanel {...sheet(byName("Contoso Orders"))} />
        </HotkeysProvider>,
      );
      const items = focusables(screen.getByRole("dialog", { name: "Contoso Orders" }));
      const outside = screen.getByRole("button", { name: "outside" });
      outside.focus();
      fireEvent.keyDown(outside, { key: "Tab" });
      expect(document.activeElement).toBe(items[0]);
      outside.focus();
      fireEvent.keyDown(outside, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(items.at(-1));
    });

    it("installs the trap when the group arrives after the sheet is already open", async () => {
      installFakeApi();
      const g = byName("Contoso Orders");
      function Late() {
        const [ready, setReady] = useState(false);
        return (
          <HotkeysProvider>
            <button type="button" onClick={() => setReady(true)}>
              load
            </button>
            <DetailPanel {...sheet(g, ready ? {} : { group: null, items: [] })} />
          </HotkeysProvider>
        );
      }
      const { user } = renderWithCore(<Late />);
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(screen.getByRole("button", { name: "load" }));
      const items = focusables(screen.getByRole("dialog", { name: "Contoso Orders" }));
      items.at(-1)!.focus();
      await user.tab();
      expect(document.activeElement).toBe(items[0]);
    });
  });

  it("disables the More menu's policy items while an action is busy", async () => {
    installFakeApi();
    const { user } = renderWithCore(
      <HotkeysProvider>
        <DetailPanel {...props(byName("Northwind Deals"), { busyAction: "delete" })} />
      </HotkeysProvider>,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const isDisabled = (name: string | RegExp) =>
      (screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled;
    expect(isDisabled(/Always OK to trash/)).toBe(true);
    expect(isDisabled(/Always keep everything from/)).toBe(true);
    expect(isDisabled("Copy sender address")).toBe(false);
  });

  it("omits the dangling separator when the account is unknown", () => {
    render(<DetailPanel {...props(byName("Northwind Deals"), { account: null })} />);
    expect(screen.getByText("promo@northwind.example")).toBeTruthy();
  });
});
