import { describe, expect, it } from "vitest";

import {
  isTocHeading,
  shouldRenderToc,
  tocEntries,
  type Heading,
} from "../../src/lib/content/toc";

function heading(depth: number, slug = `h${depth}`): Heading {
  return { depth, slug, text: slug };
}

/** A body with `count` H2 sections. */
function sections(count: number): Heading[] {
  return Array.from({ length: count }, (_, index) => heading(2, `s${index}`));
}

describe("isTocHeading", () => {
  it("accepts H2 and H3", () => {
    expect(isTocHeading(heading(2))).toBe(true);
    expect(isTocHeading(heading(3))).toBe(true);
  });

  it("rejects the article H1 and anything deeper than H3", () => {
    for (const depth of [1, 4, 5, 6]) {
      expect(isTocHeading(heading(depth))).toBe(false);
    }
  });
});

describe("tocEntries", () => {
  it("keeps document order and drops every other depth", () => {
    const entries = tocEntries([
      heading(1, "title"),
      heading(2, "one"),
      heading(3, "nested"),
      heading(4, "too-deep"),
      heading(2, "two"),
    ]);
    expect(entries.map((entry) => entry.slug)).toEqual([
      "one",
      "nested",
      "two",
    ]);
  });
});

describe("shouldRenderToc — auto", () => {
  // The rule: auto shows the table once an article has at least three
  // H2/H3 sections.
  it("hides the table below three sections", () => {
    expect(shouldRenderToc([], "auto")).toBe(false);
    expect(shouldRenderToc(sections(1), "auto")).toBe(false);
    expect(shouldRenderToc(sections(2), "auto")).toBe(false);
  });

  it("shows the table at exactly three sections", () => {
    expect(shouldRenderToc(sections(3), "auto")).toBe(true);
  });

  it("shows the table above three sections", () => {
    expect(shouldRenderToc(sections(9), "auto")).toBe(true);
  });

  it("ignores headings that are not H2 or H3 when counting", () => {
    // Two H2s plus three H4s is still two sections.
    expect(
      shouldRenderToc(
        [...sections(2), heading(4, "a"), heading(4, "b"), heading(4, "c")],
        "auto",
      ),
    ).toBe(false);
  });
});

describe("shouldRenderToc — always", () => {
  it("shows the table from a single section", () => {
    expect(shouldRenderToc(sections(1), "always")).toBe(true);
  });

  it("renders nothing at all when there is no section to link to", () => {
    // `always` is not "invent a section"; with none, there is nothing to list.
    expect(shouldRenderToc([], "always")).toBe(false);
  });
});

describe("shouldRenderToc — never", () => {
  it("hides the table however many sections exist", () => {
    expect(shouldRenderToc(sections(20), "never")).toBe(false);
  });
});
