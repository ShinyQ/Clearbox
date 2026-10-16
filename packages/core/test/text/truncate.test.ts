import { describe, expect, it } from "vitest";
import { collapseWhitespace, decodeHtmlEntities, truncateChars } from "../../src/text/truncate.ts";

describe("truncateChars", () => {
  it("keeps short strings", () => {
    expect(truncateChars("abc", 5)).toBe("abc");
  });

  it("cuts at code points, never splitting surrogate pairs", () => {
    expect(truncateChars("a\u{1F600}b", 2)).toBe("a\u{1F600}");
    expect(truncateChars("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}\u{1F600}");
  });

  it("returns empty for max <= 0", () => {
    expect(truncateChars("abc", 0)).toBe("");
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(collapseWhitespace("  a \n\t b  ")).toBe("a b");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &lt;3 &#39;hi&#x27; &quot;x&quot;")).toBe(
      `Tom & Jerry <3 'hi' "x"`,
    );
  });

  it("leaves unknown or invalid entities", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800;")).toBe("&bogus; &#0; &#xD800;");
  });
});
