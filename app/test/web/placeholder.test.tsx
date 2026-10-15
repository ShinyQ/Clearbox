import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("placeholder SPA entry", () => {
  it("renders the Clearbox heading into #root", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("../../src/web/main.tsx");
    expect(await screen.findByRole("heading", { name: "Clearbox" })).toBeTruthy();
  });
});
