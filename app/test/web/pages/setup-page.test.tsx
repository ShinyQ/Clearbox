import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MODEL_BODY } from "../../../src/web/lib/banners.ts";
import { SetupPage } from "../../../src/web/pages/SetupPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

function setup(mutate?: (s: FakeApiState) => void, path = "/setup") {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<SetupPage />, { path, route: "/setup", shell: false }) };
}

describe("Setup page", () => {
  it("walks through the three checks before any account exists", async () => {
    const { container, user } = setup((s) => void (s.accounts = []));
    expect(await screen.findByRole("heading", { level: 1, name: "Set up Clearbox" })).toBeTruthy();
    expect(
      await screen.findByText("Protected by Cloudflare Access. Signed in as owner@example.test."),
    ).toBeTruthy();
    expect(screen.getByText("Connected to your Decision-1 deployment.")).toBeTruthy();
    expect(screen.getByText("Connect Gmail or Outlook. You'll sign in on their page.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sorting your first emails" })).toBeNull();
    expect(
      screen.getByText(
        /^Clearbox can only move mail to Trash or Archive\. It never permanently deletes or sends email\./,
      ),
    ).toBeTruthy();
    expect(document.title).toBe("Set up Clearbox");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/setup");
  });

  it("shows model problems and local development mode in the steps", async () => {
    setup((s) => {
      s.accounts = [];
      s.me = {
        ...s.me,
        environment: "development",
        issues: [{ code: "decision_not_configured", since: iso(T0), accountId: null }],
      };
    });
    expect(
      await screen.findByText("Local development mode. Sign-in is bypassed on localhost only."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${MODEL_BODY.decision_not_configured} New emails will be marked Check until this is fixed.`,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open setup guide" })).toBeTruthy();
  });

  it("shows sorting progress and enables Go to Review once groups exist", async () => {
    const { router, user } = setup();
    expect(await screen.findByText("you@example.com connected.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sorting your first emails" })).toBeTruthy();
    expect(
      screen.getByText("Sorting your inbox, newest first (step 2 of 3). 8,200 emails sorted."),
    ).toBeTruthy();
    expect(screen.getByText("Caught up (step 3 of 3).")).toBeTruthy();
    expect(await screen.findByText("7 sender groups are ready.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Go to Review" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });

  it("keeps Go to Review disabled until the first suggestions exist", async () => {
    setup((s) => void (s.items = []));
    expect(await screen.findByText("Your first suggestions appear within a few minutes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to Review" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the OAuth result above the panel", async () => {
    setup((s) => void (s.accounts = []), "/setup?error=scope_missing&provider=gmail");
    expect(await screen.findByText("Some permissions were not granted.")).toBeTruthy();
  });
});
