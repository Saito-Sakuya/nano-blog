import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createHeadingSlugger,
  slugifyHeading,
} from "../../src/lib/markdown/slug";

/** The documented fallback: `section-` plus 8 hex of the NFC text's SHA-256. */
function expectedHashSlug(text: string): string {
  const digest = createHash("sha256")
    .update(text.normalize("NFC"), "utf8")
    .digest("hex");
  return `section-${digest.slice(0, 8)}`;
}

describe("slugifyHeading", () => {
  it("lower-cases and hyphenates a Latin heading", () => {
    expect(slugifyHeading("Getting Started")).toBe("getting-started");
    expect(slugifyHeading("  Spaced   Out  ")).toBe("spaced-out");
  });

  it("strips characters that are not slug-safe ASCII", () => {
    expect(slugifyHeading("C++ & Rust!")).toBe("c-rust");
    expect(slugifyHeading("a_b")).toBe("ab");
  });

  it("collapses runs of hyphens and trims them from the ends", () => {
    expect(slugifyHeading("a -- b")).toBe("a-b");
    expect(slugifyHeading("-- edge --")).toBe("edge");
  });

  it("falls back to a hash for a heading containing CJK text", () => {
    const heading = "一级小节 Latine";
    expect(slugifyHeading(heading)).toBe(expectedHashSlug(heading));
    expect(slugifyHeading(heading)).toMatch(/^section-[0-9a-f]{8}$/u);
  });

  it("falls back to a hash when nothing slug-safe survives", () => {
    const heading = "!!!";
    expect(slugifyHeading(heading)).toBe(expectedHashSlug(heading));
  });

  it("is stable: the same heading always produces the same slug", () => {
    const heading = "记录微小发现";
    expect(slugifyHeading(heading)).toBe(slugifyHeading(heading));
  });

  it("normalises to NFC before hashing, so equivalent text collides as intended", () => {
    // "é" as a single code point versus "e" + combining acute.
    const composed = "café";
    const decomposed = "café";
    expect(slugifyHeading(composed)).toBe(slugifyHeading(decomposed));
  });
});

describe("createHeadingSlugger", () => {
  it("suffixes repeated slugs in document order", () => {
    const slug = createHeadingSlugger();
    expect(slug("Notes")).toBe("notes");
    expect(slug("Notes")).toBe("notes-2");
    expect(slug("Notes")).toBe("notes-3");
  });

  it("keeps distinct headings independent", () => {
    const slug = createHeadingSlugger();
    expect(slug("Alpha")).toBe("alpha");
    expect(slug("Beta")).toBe("beta");
    expect(slug("Alpha")).toBe("alpha-2");
  });

  it("suffixes repeated CJK headings too", () => {
    const slug = createHeadingSlugger();
    const first = slug("重复标题");
    const second = slug("重复标题");
    expect(first).toMatch(/^section-[0-9a-f]{8}$/u);
    expect(second).toBe(`${first}-2`);
  });

  it("skips a slug another heading already took", () => {
    // `## A` / `## A` / `## A-2`: counting each base independently produced
    // `a`, `a-2`, `a-2` — the third heading's own base is `a-2`, which the
    // second heading had already claimed — so the page carried two elements
    // with the same id and every `#a-2` link was ambiguous.
    const slug = createHeadingSlugger();
    expect(slug("A")).toBe("a");
    expect(slug("A")).toBe("a-2");
    expect(slug("A-2")).toBe("a-2-2");
  });

  it("never takes a slug a later heading would expect to own", () => {
    // The suffix belongs to the heading's own base. `A-3` must still be able to
    // claim `a-3`.
    const slug = createHeadingSlugger();
    expect(slug("A")).toBe("a");
    expect(slug("A")).toBe("a-2");
    expect(slug("A-2")).toBe("a-2-2");
    expect(slug("A-3")).toBe("a-3");
  });

  it("keeps incrementing the suffix while it is taken", () => {
    const slug = createHeadingSlugger();
    expect(slug("A")).toBe("a");
    expect(slug("A")).toBe("a-2");
    expect(slug("A-2")).toBe("a-2-2");
    // A second `A-2`: its own suffix is taken too, so the search continues.
    expect(slug("A-2")).toBe("a-2-3");
    expect(slug("A")).toBe("a-3");
  });

  it("never returns the same slug twice for any sequence of headings", () => {
    const slug = createHeadingSlugger();
    const headings = ["A", "A", "A-2", "A", "A-2", "A-3", "a", "A"];
    const slugs = headings.map((heading) => slug(heading));

    expect(new Set(slugs).size).toBe(slugs.length);
    // …and every slug is the heading's base slug or that base plus a suffix.
    for (const [index, heading] of headings.entries()) {
      expect(slugs[index]).toMatch(
        new RegExp(`^${slugifyHeading(heading)}(?:-\\d+)*$`, "u"),
      );
    }
  });
});
