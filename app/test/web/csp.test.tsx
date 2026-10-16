import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeeklyChart } from "../../src/web/components/insights/WeeklyChart.tsx";
import { SplitBar } from "../../src/web/components/review/SplitBar.tsx";
import { SkeletonLine } from "../../src/web/components/ui/Skeleton.tsx";
import { ComponentGallery } from "../../src/web/pages/ComponentGallery.tsx";
import { HotkeysProvider } from "../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "./helpers/core.tsx";
import { createFakeApiState } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

function styledProperties(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>("[style]")].flatMap((el) =>
    Array.from({ length: el.style.length }, (_, i) => el.style[i] ?? ""),
  );
}

describe("CSP-safe geometry (UI spec 8.4)", () => {
  it("sets only --cb-* custom properties through style props across the gallery", () => {
    installFakeApi();
    const { container } = renderWithCore(
      <HotkeysProvider>
        <ComponentGallery />
      </HotkeysProvider>,
    );
    const props = styledProperties(container);
    expect(props.length).toBeGreaterThan(5);
    expect(props.filter((p) => !p.startsWith("--cb-"))).toEqual([]);
  });

  it("covers the chart, split bar and skeleton geometry too", () => {
    const { container } = render(
      <>
        <WeeklyChart weeks={createFakeApiState().insights.weekly} state="ready" />
        <SplitBar segments={[{ key: "t", className: "bg-trash", value: 3, legend: "3 to trash" }]} />
        <SkeletonLine width={120} />
      </>,
    );
    expect(styledProperties(container).filter((p) => !p.startsWith("--cb-"))).toEqual([]);
  });
});
