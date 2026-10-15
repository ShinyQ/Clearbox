import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "./helpers/axe.ts";
import { setReducedMotion, setViewport } from "./helpers/viewport.ts";
import { createFakeApiState, deriveGroups, previewOf, summaryOf } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

describe("fake API", () => {
  it("answers same-origin fetches and reports tau from state", async () => {
    const state = installFakeApi();
    const res = await fetch(new URL("/api/me", window.location.origin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; tauDelete: number };
    expect(body.email).toBe("owner@example.test");
    expect(body.tauDelete).toBe(state.tau);
  });

  it("rejects a mutation without the CSRF header", async () => {
    installFakeApi();
    const res = await fetch(new URL("/api/override", window.location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1], action: "keep" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_required");
  });

  it("derives groups, summary and preview from the default dataset", () => {
    const s = createFakeApiState();
    expect(deriveGroups(s)).toHaveLength(7);
    const summary = summaryOf(s);
    expect(summary.pending.total).toBe(27);
    expect(summary.groupsByAction).toEqual({ delete: 3, archive: 2, keep: 1, unsure: 1 });
    const preview = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
    expect(preview.count).toBe(14);
    expect(preview.byAction).toEqual({ delete: 11, archive: 3, keep: 0 });
    expect(preview.groups).toBe(4);
    expect(preview.groupsLeft).toBe(4);
  });
});

describe("axe helper", () => {
  it("fails on an image without alt text", async () => {
    const img = document.createElement("img");
    img.src = "/x.png";
    document.body.append(img);
    await expect(expectNoA11yViolations()).rejects.toThrow();
    img.remove();
  });

  it("passes on a labelled button", async () => {
    const button = document.createElement("button");
    button.textContent = "Save changes";
    document.body.append(button);
    await expectNoA11yViolations();
    button.remove();
  });
});

describe("viewport helper", () => {
  it("drives matchMedia for width and reduced motion", () => {
    expect(window.matchMedia("(min-width: 80rem)").matches).toBe(true);
    act(() => setViewport(1100));
    expect(window.matchMedia("(min-width: 80rem)").matches).toBe(false);
    expect(window.matchMedia("(min-width: 64rem)").matches).toBe(true);
    act(() => setReducedMotion(true));
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  });
});
