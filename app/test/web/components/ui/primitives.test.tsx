import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../../../src/web/components/ui/Button.tsx";
import { Checkbox } from "../../../../src/web/components/ui/Checkbox.tsx";
import { cssVars } from "../../../../src/web/components/ui/css-vars.ts";
import { Icon } from "../../../../src/web/components/ui/icons.tsx";
import { Kbd } from "../../../../src/web/components/ui/Kbd.tsx";
import { Select } from "../../../../src/web/components/ui/Select.tsx";
import { TextInput } from "../../../../src/web/components/ui/TextInput.tsx";
import { Toggle } from "../../../../src/web/components/ui/Toggle.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";

describe("cssVars", () => {
  it("passes --cb-* properties through", () => {
    expect(cssVars({ "--cb-value": 0.97, "--cb-tau": 0.86 })).toEqual({
      "--cb-value": 0.97,
      "--cb-tau": 0.86,
    });
  });

  it("throws on any other property in development", () => {
    expect(() => cssVars({ color: "red" } as never)).toThrow("cssVars only accepts --cb-* properties");
  });
});

describe("Button", () => {
  it("shows the loading label, sets aria-busy and ignores clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Clean up 14
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Working…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("soft-disables with aria-disabled so it stays focusable", async () => {
    const onClick = vi.fn();
    render(
      <Button softDisabled onClick={onClick}>
        Clean up
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Clean up" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders shortcut keys hidden from assistive tech", () => {
    render(
      <Button variant="primary" kbd={["Ctrl", "Enter"]} aria-keyshortcuts="Control+Enter">
        Clean up
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Clean up" });
    expect([...button.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "Enter"]);
  });
});

describe("form controls", () => {
  it("Checkbox supports mixed and reports the next value", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox checked="mixed" onChange={onChange} label="Select all groups in Trash" />,
    );
    const box = screen.getByRole("checkbox", { name: "Select all groups in Trash" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    rerender(<Checkbox checked onChange={onChange} label="Select all groups in Trash" />);
    expect(box.indeterminate).toBe(false);
  });

  it("Toggle is a switch; locked toggles stay on", async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return (
        <>
          <Toggle checked={on} onChange={setOn} label="Store email previews" />
          <Toggle checked={false} onChange={() => undefined} label="Protect starred threads" locked />
        </>
      );
    }
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Store email previews" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const locked = screen.getByRole("switch", { name: "Protect starred threads" });
    expect(locked.getAttribute("aria-checked")).toBe("true");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
  });

  it("TextInput links helper and error text", () => {
    render(<TextInput label="Record word" helper="2 to 40 characters." error="Use 2 to 40 characters." />);
    const input = screen.getByRole("textbox", { name: "Record word" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["2 to 40 characters.", "Use 2 to 40 characters."]);
  });

  it("Select reports the typed value", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Account"
        value="all"
        onChange={onChange}
        options={[
          { value: "all", label: "All accounts" },
          { value: "acc_1", label: "you@example.com" },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Account" }), "acc_1");
    expect(onChange).toHaveBeenCalledWith("acc_1");
  });

  it("renders Kbd keys and hidden icons accessibly", async () => {
    render(
      <div>
        <Kbd keys={["G", "R"]} />
        <Icon name="trash" />
        <Button icon="trash" variant="danger">
          Trash 6
        </Button>
        <Checkbox checked={false} onChange={() => undefined} label="Select Northwind Deals" />
      </div>,
    );
    expect(document.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await expectNoA11yViolations();
  });
});
