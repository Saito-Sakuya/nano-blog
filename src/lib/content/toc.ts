/**
 * Table-of-contents policy.
 *
 * Only H2 and H3 ever appear. The article title is the document's only H1, and
 * anything deeper than H3 makes for a list nobody reads.
 */

export interface Heading {
  readonly depth: number;
  readonly slug: string;
  readonly text: string;
}

/** Whether a heading belongs in the table of contents. */
export function isTocHeading(heading: Heading): boolean {
  return heading.depth === 2 || heading.depth === 3;
}

/**
 * Decide whether to render a table of contents for an article.
 *
 * - `auto`   — only once the article has at least three sections
 * - `always` — as soon as there is a single section
 * - `never`  — no table of contents, regardless of length
 */
export function shouldRenderToc(
  headings: readonly Heading[],
  mode: "auto" | "always" | "never",
): boolean {
  if (mode === "never") return false;

  const sections = headings.filter(isTocHeading).length;
  return mode === "always" ? sections >= 1 : sections >= 3;
}

/** The headings to list, in document order. */
export function tocEntries(headings: readonly Heading[]): Heading[] {
  return headings.filter(isTocHeading);
}
