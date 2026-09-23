import type { Page } from "@playwright/test";

import { expect, test, visit } from "./fixtures.js";

/**
 * The space between the article header and its body.
 *
 * Two defects lived here, and both were invisible to every gate the project
 * has: axe measures contrast, Lighthouse measures budgets, and neither has an
 * opinion about a gap that is 170px larger than it should be. The maintainer
 * saw it on the page.
 *
 *   1. The prose's first block kept its own top margin. An article opening with
 *      `##` inherited the heading's 3.5em lead-in (86.8px at the article size)
 *      on top of everything the header already provided, while an article
 *      opening with a paragraph started immediately — the same stylesheet
 *      producing two different openings, decided by nothing but the author's
 *      first line.
 *   2. The cover carried a bottom margin *and* sat inside a header that ends
 *      with padding, so two identical 24px gaps stacked below the image.
 *
 * These assertions are about the two mechanisms rather than about one pixel
 * count, so a future change to the tokens does not have to come back here —
 * except for the last one, which is deliberately a budget.
 */

const ARTICLE = "/posts/notes/first-note/";

interface Spacing {
  readonly coverMarginBlockEnd: string;
  readonly coverPosition: string;
  readonly headPaddingBlockEnd: string;
  readonly bodyPaddingBlockStart: string;
  readonly firstChildTag: string | null;
  readonly firstChildMarginBlockStart: string | null;
  readonly coverBottom: number;
  readonly proseTop: number;
  readonly creditBottom: number | null;
  readonly creditHeight: number;
  readonly creditMarginTop: string;
  readonly gap: number;
}

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const num = (v) => Math.round(Number.parseFloat(v) * 100) / 100;
  const cover = q('.article-cover');
  const credit = q('.article-credit');
  const prose = q('.prose');
  const body = q('.article-body');
  const head = q('.article-head');
  const first = prose === null ? null : prose.firstElementChild;
  const cs = (el, prop) => (el === null ? null : getComputedStyle(el).getPropertyValue(prop));
  const rect = (el) => (el === null ? null : el.getBoundingClientRect());
  const coverRect = rect(cover);
  const proseRect = rect(prose);
  const creditRect = rect(credit);
  return JSON.stringify({
    coverMarginBlockEnd: cs(cover, 'margin-block-end'),
    coverPosition: cs(cover, 'position'),
    headPaddingBlockEnd: cs(head, 'padding-block-end'),
    bodyPaddingBlockStart: cs(body, 'padding-block-start'),
    firstChildTag: first === null ? null : first.tagName,
    firstChildMarginBlockStart: first === null ? null : cs(first, 'margin-block-start'),
    coverBottom: coverRect === null ? 0 : num(coverRect.bottom),
    proseTop: proseRect === null ? 0 : num(proseRect.top),
    creditBottom: creditRect === null ? null : num(creditRect.bottom),
    creditHeight: creditRect === null ? 0 : num(creditRect.height),
    creditMarginTop: cs(credit, 'margin-block-start') ?? '0px',
    gap: coverRect === null || proseRect === null ? 0 : num(proseRect.top - coverRect.bottom),
  });
})()`;

async function measure(page: Page): Promise<Spacing> {
  return JSON.parse((await page.evaluate(MEASURE)) as string) as Spacing;
}

test.describe("article spacing", () => {
  test("the prose does not start with its own lead-in", async ({ page }) => {
    await visit(page, ARTICLE);
    const spacing = await measure(page);

    // The fixture article opens with an `h2`, which is the case that exposed
    // this. If the fixture ever opens with a paragraph instead, this assertion
    // stops being about the defect and should be reconsidered rather than
    // deleted — hence the explicit check on the tag.
    expect(
      spacing.firstChildTag,
      "the fixture no longer opens with a heading, so this test is not testing the defect",
    ).toBe("H2");

    expect(
      spacing.firstChildMarginBlockStart,
      "the first block of the prose kept its lead-in, so the article's opening gap depends on what the author wrote first",
    ).toBe("0px");
  });

  test("the gap is exactly what the layout asks for, with nothing from the first block", async ({
    page,
  }) => {
    /*
     * The invariant behind the complaint, stated as arithmetic: the distance from
     * the cover to the first line of the prose is whatever sits between them and
     * nothing else — the credit line when the cover has one, plus the body's top
     * spacing. Nothing else may contribute, and the thing that used to contribute
     * was the first block's own lead-in, which is why the opening depended on
     * whether the author wrote a heading or a paragraph first.
     *
     * The header's own padding is *not* in that sum, and the distinction was
     * measured rather than assumed: above 48rem the cover is lifted out of the
     * flow with `inset: 0` and covers the header including its padding, so the
     * padding is already behind the image; below 48rem the cover is an ordinary
     * figure and the padding does follow it. Adding it unconditionally is what a
     * previous version of this test did, and it failed on every wide viewport.
     */
    for (const url of [
      "/posts/notes/first-note/",
      "/posts/notes/toc-always/",
    ]) {
      await visit(page, url);
      const spacing = await measure(page);

      const coverIsLaidOut = spacing.coverPosition !== "absolute";
      const parts =
        (coverIsLaidOut ? Number.parseFloat(spacing.headPaddingBlockEnd) : 0) +
        spacing.creditHeight +
        Number.parseFloat(spacing.creditMarginTop) +
        Number.parseFloat(spacing.bodyPaddingBlockStart);

      expect(
        Math.abs(spacing.gap - parts),
        `at ${url} the gap is ${spacing.gap}px but its parts add up to ${parts}px: ` +
          `cover ${spacing.coverPosition} (header padding ${spacing.headPaddingBlockEnd} ${coverIsLaidOut ? "counts" : "is behind the cover"}) + ` +
          `credit ${spacing.creditHeight} + credit margin ${spacing.creditMarginTop} + body ${spacing.bodyPaddingBlockStart}, ` +
          `with the first block (${spacing.firstChildTag}) contributing ${spacing.firstChildMarginBlockStart}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("the cover does not add a second gap under the image", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 1200 });
    await visit(page, ARTICLE);
    const spacing = await measure(page);

    expect(
      spacing.coverMarginBlockEnd,
      "the cover kept a bottom margin on top of the header's own padding",
    ).toBe("0px");
  });

  test("the wide-screen cover still fills the header it is placed in", async ({
    page,
  }) => {
    /*
     * The cover's margins were the reason a wide-screen `margin: 0` never took
     * effect: the base rule came later in the file at the same specificity, so
     * the absolutely positioned cover kept a 24px bottom margin it was never
     * meant to have. Asserting the margin alone would not catch a return of
     * that, because the margin is read from whichever rule wins.
     */
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, ARTICLE);
    const spacing = await measure(page);

    expect(
      spacing.coverPosition,
      "the cover is not lifted out of the flow",
    ).toBe("absolute");
    expect(spacing.coverMarginBlockEnd).toBe("0px");
  });

  test("the cover-to-body gap stays within its budget", async ({ page }) => {
    /*
     * A budget rather than an equality, because the gap is made of a token plus
     * the credit line, and both can legitimately move. Measured after the fix:
     * 116.39px at 700px wide and 60.39px at 1280px. Before the fix the same
     * measurements were 227.19px and 139.19px.
     *
     * The two differ by design rather than by accident: below 48rem the cover is
     * an ordinary figure in the flow, so the header's own padding is added below
     * it; above 48rem it is lifted out to sit behind the title, and only the
     * body's spacing follows. The budgets sit well above each measurement and
     * well below what a returning first-block lead-in would add (86.8px), so the
     * defect cannot come back unnoticed.
     */
    for (const [width, budget] of [
      [700, 130],
      [1280, 75],
    ] as const) {
      await page.setViewportSize({ width, height: 1200 });
      await visit(page, ARTICLE);
      const spacing = await measure(page);

      expect(
        spacing.gap,
        `the gap under the cover is ${spacing.gap}px at ${width}px wide (budget ${budget}): ` +
          `header padding ${spacing.headPaddingBlockEnd}, body padding ${spacing.bodyPaddingBlockStart}, ` +
          `cover margin ${spacing.coverMarginBlockEnd}, first block ${spacing.firstChildTag} margin ${spacing.firstChildMarginBlockStart}`,
      ).toBeLessThan(budget);
    }
  });
});
