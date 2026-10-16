import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComponentGallery } from "../../../src/web/pages/ComponentGallery.tsx";
import { HotkeysProvider } from "../../../src/web/state/HotkeysProvider.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderWithCore } from "../helpers/core.tsx";
import { installFakeApi } from "../msw/handlers.ts";

describe("Component gallery", () => {
  it("renders every card of UI spec 5.7 without accessibility violations", async () => {
    installFakeApi();
    const { container } = renderWithCore(
      <HotkeysProvider>
        <ComponentGallery />
      </HotkeysProvider>,
      { path: "/dev/components" },
    );
    for (const title of [
      "Buttons",
      "Verdict tags (icon + word, never color alone)",
      "Confidence scale (tick = Clean up threshold, tuned nightly)",
      "Rows",
      "Banners and toasts",
      "Inputs",
      "Empty states and skeletons",
      "Confirm bar",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("Clean up 1,284")).toBeTruthy();
    expect(screen.getByText("Cleaning up… 812 of 1,284")).toBeTruthy();
    expect(screen.getByText("Stopping after this step…")).toBeTruthy();
    expect(
      screen
        .getAllByRole("region", { name: "Clean up" })
        .some((bar) => within(bar).queryByRole("button", { name: "Reconnect" })),
    ).toBe(true);
    expect(document.title).toBe("Components · Clearbox");
    await expectNoA11yViolations(container);
  });
});
