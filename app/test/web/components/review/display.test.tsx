import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceLabel } from "../../../../src/web/components/review/ConfidenceLabel.tsx";
import { ReasonList } from "../../../../src/web/components/review/ReasonLine.tsx";
import { SenderAvatar } from "../../../../src/web/components/review/SenderAvatar.tsx";
import { SplitBar } from "../../../../src/web/components/review/SplitBar.tsx";
import { VerdictTag } from "../../../../src/web/components/review/VerdictTag.tsx";
import { avatarColorIndex } from "../../../../src/web/lib/avatar.ts";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState } from "../../msw/fake-api.ts";

const meterVars = (root: HTMLElement) => {
  const meter = root.querySelector<HTMLElement>(".cb-meter");
  return [meter?.style.getPropertyValue("--cb-value"), meter?.style.getPropertyValue("--cb-tau")];
};

describe("SenderAvatar and VerdictTag", () => {
  it("renders a deterministic monogram and a ? for unknown senders", () => {
    const { container } = render(
      <>
        <SenderAvatar
          name="Northwind Deals"
          address="promo@northwind.example"
          domain="northwind.example"
          size={22}
        />
        <SenderAvatar name={null} address="" domain="" size={30} />
      </>,
    );
    const [known, unknown] = [...container.querySelectorAll("span[aria-hidden='true']")];
    expect(known?.textContent).toBe("N");
    expect(known?.className).toContain(`bg-avatar-${avatarColorIndex("northwind.example")}`);
    expect(unknown?.textContent).toBe("?");
    expect(unknown?.className).toContain("bg-neutral-fill");
  });

  it("always shows an icon plus a word", () => {
    render(
      <>
        <VerdictTag kind="delete" />
        <VerdictTag kind="unsure" />
        <VerdictTag kind="protected" size="sm" />
        <VerdictTag kind="delete" label="Move 6 to Trash" />
      </>,
    );
    expect(
      screen.getByText("Trash").closest(".cb-tag")?.querySelector("svg[aria-hidden='true']"),
    ).toBeTruthy();
    expect(screen.getByText("Check")).toBeTruthy();
    expect(screen.getByText("Protected")).toBeTruthy();
    expect(screen.getByText("Move 6 to Trash")).toBeTruthy();
  });
});

describe("ConfidenceLabel", () => {
  const tau = createFakeApiState().tau;

  it("bands the cell with tau from the API and sets meter geometry through --cb-* only", () => {
    const { container } = render(<ConfidenceLabel value={0.85} verdict="delete" tau={tau} variant="cell" />);
    expect(container.textContent).toContain("85%");
    expect(container.textContent).toContain("Likely");
    expect(screen.getByText("85 percent, Likely")).toBeTruthy();
    expect(meterVars(container)).toEqual(["0.85", String(tau)]);
  });

  it("moves the boundary when tau moves", () => {
    const { container, rerender } = render(
      <ConfidenceLabel value={0.85} verdict="delete" tau={0.8} variant="cell" />,
    );
    expect(container.textContent).toContain("Sure");
    rerender(<ConfidenceLabel value={0.97} verdict="archive" tau={0.8} variant="cell" />);
    expect(container.textContent).toContain("Very sure");
  });

  it("adds the left-for-you hint and the model-unavailable state inline", () => {
    const { container, rerender } = render(
      <ConfidenceLabel value={0.78} verdict="archive" tau={tau} variant="inline" />,
    );
    expect(container.textContent).toBe("78%Likely· left for you");
    rerender(<ConfidenceLabel value={0.5} verdict="unsure" tau={tau} variant="inline" modelUnavailable />);
    expect(container.textContent).toBe("n/aUnsure· model unavailable");
  });

  it("computes the scale cards from tau", () => {
    render(<ConfidenceLabel value={0} verdict="delete" tau={0.88} variant="scale" />);
    expect(screen.getByText("88 to 94%")).toBeTruthy();
    expect(screen.getByText("70 to 87%")).toBeTruthy();
  });
});

describe("ReasonList and SplitBar", () => {
  it("renders reason text verbatim with icons hidden", () => {
    render(
      <ReasonList
        reasons={[
          { code: "list_unsubscribe", text: "Has an unsubscribe link" },
          { code: "guard_starred", text: "You starred or flagged this email" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Reasons" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Has an unsubscribe link", "You starred or flagged this email"]);
  });

  it("renders zero to three reasons gracefully", () => {
    const { container, rerender } = render(<ReasonList reasons={[]} />);
    expect(container.querySelector("ul")).toBeNull();
    rerender(<ReasonList reasons={[{ code: "bulk_mail", text: "Sent in bulk" }]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    rerender(
      <ReasonList
        reasons={[
          { code: "bulk_mail", text: "Sent in bulk" },
          { code: "low_open_rate", text: "You rarely open these" },
          { code: "old_unread", text: "Unread for a long time" },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("omits zero segments and grows segments through --cb-grow", async () => {
    const { container } = render(
      <SplitBar
        segments={[
          { key: "trash", className: "bg-trash", value: 11, legend: "11 to trash" },
          { key: "archive", className: "bg-archive", value: 0, legend: "0 to archive" },
          { key: "left", className: "bg-neutral-fill", value: 13, legend: "13 to check or keep" },
        ]}
      />,
    );
    expect(
      [...container.querySelectorAll(".cb-grow")].map((el) =>
        (el as HTMLElement).style.getPropertyValue("--cb-grow"),
      ),
    ).toEqual(["11", "13"]);
    expect(screen.queryByText("0 to archive")).toBeNull();
    await expectNoA11yViolations(container);
  });
});
