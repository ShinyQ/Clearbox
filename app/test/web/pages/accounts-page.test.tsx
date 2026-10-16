import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "../../../src/web/lib/links.ts";
import { AccountsPage } from "../../../src/web/pages/AccountsPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { setViewport } from "../helpers/viewport.ts";
import type { FakeApiState } from "../msw/fake-api.ts";
import { ACC_GMAIL, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(mutate?: (s: FakeApiState) => void, path = "/accounts") {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<AccountsPage />, { path, route: "/accounts" }) };
}

describe("Accounts page", () => {
  it("shows a card per account with status lines, actions and the footer note", async () => {
    const { container } = setup();
    const gmail = await screen.findByRole("group", { name: "you@example.com" });
    expect(within(gmail).getByText(/^Gmail · up to date · 32,118 emails sorted · connected /)).toBeTruthy();
    const outlook = screen.getByRole("group", { name: "you@example.net" });
    expect(
      within(outlook).getByText(/^Outlook · catching up, 11,800 left \(about 2 days\) · connected /),
    ).toBeTruthy();
    expect(
      within(outlook)
        .getByRole("progressbar", { name: "Sorting progress for you@example.net" })
        .getAttribute("aria-valuenow"),
    ).toBe("41");
    expect(within(gmail).getByRole("button", { name: "Pause you@example.com" })).toBeTruthy();
    expect(
      screen.getByText(
        "Clearbox can only move mail to Trash or Archive. It can never permanently delete or send email.",
      ),
    ).toBeTruthy();
    expect(document.title).toBe("Accounts · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("pauses optimistically and rolls back on error", async () => {
    const { user } = setup((s) => {
      s.failures.patchAccount = { status: 500, code: "internal", times: 1 };
    });
    await user.click(await screen.findByRole("button", { name: "Pause you@example.com" }));
    expect(await screen.findByText("Couldn't pause you@example.com. Try again.")).toBeTruthy();
    expect(screen.getByText(/^Gmail · up to date/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause you@example.com" }));
    expect(await screen.findByText("Paused sorting for you@example.com.")).toBeTruthy();
    expect(await screen.findByText("Gmail · paused by you · 32,118 emails sorted")).toBeTruthy();
  });

  it("disconnects after an inline confirm", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.com" }));
    expect(
      screen.getByText(
        "Disconnect you@example.com? Clearbox stops sorting it and deletes its stored data tonight. Your mailbox is not changed.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected you@example.com. Google access was revoked.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("group", { name: "you@example.com" })).toBeNull());
  });

  it("explains how to remove Outlook consent after disconnecting", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.net" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected you@example.net.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Personal account" }).getAttribute("href")).toBe(
      "https://account.live.com/consent/Manage",
    );
    expect(screen.getByRole("link", { name: "Work or school account" })).toBeTruthy();
  });

  it("consumes an OAuth error and removes the query", async () => {
    const { router } = setup(undefined, "/accounts?error=access_denied&provider=gmail");
    expect(await screen.findByText("Access was not granted.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("toasts a fresh connection", async () => {
    setup(undefined, `/accounts?connected=${ACC_GMAIL}`);
    expect(
      await screen.findByText("Connected you@example.com. Sorting starts within a minute."),
    ).toBeTruthy();
  });

  it("starts Connect and Reconnect through the provider sign-in", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { user } = setup((s) => {
      s.accounts[1] = { ...s.accounts[1]!, status: "needs_reauth" };
    });
    expect(await screen.findByText("Outlook · paused, needs reconnect")).toBeTruthy();
    const card = screen.getByRole("group", { name: "you@example.net" });
    await user.click(within(card).getByRole("button", { name: "Reconnect you@example.net" }));
    expect(assign).toHaveBeenLastCalledWith("/oauth/microsoft/start?loginHint=you%40example.net");
    await user.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(assign).toHaveBeenLastCalledWith("/oauth/google/start");
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/accounts");
  });

  it("explains a provider that is not configured", async () => {
    setup((s) => {
      s.me = { ...s.me, providers: { gmail: false, outlook: true } };
    });
    expect(
      await screen.findByText(
        "Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/setup-google.md).",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Gmail" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("scans one account and reports the outcome", async () => {
    const { user } = setup((s) => {
      s.scanDecided = 4;
    });
    await user.click(await screen.findByRole("button", { name: "Scan now you@example.com" }));
    expect(await screen.findByText("Scan finished. 4 new emails sorted.")).toBeTruthy();
  });

  it("explains busy, backing-off and exhausted scans the same way as Review", async () => {
    const retryAt = new Date(T0 + 5 * 60_000).toISOString();
    const { user, state } = setup((s) => {
      s.failures.scan = { status: 409, code: "account_busy", retryAt, times: 1 };
    });
    const scanButton = await screen.findByRole("button", { name: "Scan now you@example.com" });
    await user.click(scanButton);
    expect(
      await screen.findByText("A scan is already running for you@example.com. Try again in 5 min."),
    ).toBeTruthy();
    state.failures.scan = { status: 409, code: "account_inactive", retryAt, times: 1 };
    await user.click(scanButton);
    expect(
      await screen.findByText(/^you@example\.com is retrying after a problem\. Next try at /),
    ).toBeTruthy();
    state.failures.scan = { status: 409, code: "account_inactive", times: 1 };
    await user.click(scanButton);
    expect(await screen.findByText("you@example.com is paused.")).toBeTruthy();
    state.failures.scan = { status: 429, code: "budget_exhausted", retryAt, times: 1 };
    await user.click(scanButton);
    expect(
      await screen.findByText(/^Today's free-tier limit is reached\. Scanning resumes after /),
    ).toBeTruthy();
  });

  it("returns focus to Disconnect when the confirm is cancelled in the wide layout", async () => {
    const { user } = setup();
    const trigger = await screen.findByRole("button", { name: "Disconnect you@example.com" });
    await user.click(trigger);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("returns focus to the actions menu trigger when the confirm is cancelled in the narrow layout", async () => {
    setViewport(900);
    const { user } = setup();
    const trigger = await screen.findByRole("button", { name: "Account actions for you@example.com" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves focus to the page heading after a successful disconnect", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.com" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "you@example.com" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Accounts" }));
  });

  it("disables Scan now in the menu while a scan is running", async () => {
    setViewport(900);
    const { user } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post("*/api/accounts/:id/scan", async () => {
        await gate;
        return HttpResponse.json({
          outcome: "idle",
          accountId: ACC_GMAIL,
          kind: "incremental",
          phase: "incremental",
          fetched: 0,
          skippedKnown: 0,
          decided: 0,
          deferred: 0,
          unsure: 0,
          removed: 0,
          subrequests: 1,
          rowsWritten: 0,
          nextTickAt: null,
          errorCode: null,
        });
      }),
    );
    const trigger = await screen.findByRole("button", { name: "Account actions for you@example.com" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Scan now" }));
    await user.click(trigger);
    expect((await screen.findByRole("menuitem", { name: "Scan now" })).hasAttribute("disabled")).toBe(true);
    release();
    expect(await screen.findByText("Scan finished. No new emails.")).toBeTruthy();
  });

  it("keeps a consent banner per Outlook account and lets it be dismissed", async () => {
    const { user } = setup((s) => {
      s.accounts.push({ ...s.accounts[1]!, id: "acc_outlook2", email: "work@example.org" });
    });
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.net" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected you@example.net.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Disconnect work@example.org" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected work@example.org.")).toBeTruthy();
    expect(screen.getByText("Disconnected you@example.net.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss: Disconnected you@example.net." }));
    await waitFor(() => expect(screen.queryByText("Disconnected you@example.net.")).toBeNull());
    expect(screen.getByText("Disconnected work@example.org.")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    setup((s) => void (s.accounts = []));
    expect(await screen.findByRole("heading", { name: "No accounts yet" })).toBeTruthy();
  });
});
