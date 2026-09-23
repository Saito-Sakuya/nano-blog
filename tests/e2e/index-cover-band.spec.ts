import { expect, MEDIA_ORIGIN, test, visit } from "./fixtures.js";

/**
 * The cover band on a list row.
 *
 * A row's cover is lifted out of the flow, pinned to the trailing edge and
 * masked so it dissolves into the row, in the same visual language as the
 * article page's cover. Because it is positioned rather than laid out, the
 * geometry is not enforced by anything visible: the row has to reserve the
 * space, the band has to stay inside it, and the text has to stop before it.
 * Three numbers from two files have to agree, and if they drift the failure is
 * either text over an image (unreadable, and invisible to axe, which measures
 * text against background *colours*) or covers overlapping each other.
 *
 * The tests below assert exactly those three things, at four widths, against
 * the rendered boxes rather than against the stylesheet. They are the reason
 * this arrangement can be trusted; without them it is only as good as the last
 * time somebody looked at it.
 */

/*
 * The suite runs twice: fixture build, then the empty one. This file needs the
 * fixture build — the empty build has no rows to measure — which is the same
 * guard `content.spec.ts` uses.
 */
const EMPTY_BUILD = process.env["E2E_EMPTY"] === "1";

test.skip(EMPTY_BUILD, "the empty build has no content to exercise");

/** Pages that render `.index-row`, so all three list surfaces are covered. */
const LIST_PAGES = [
  { name: "home", url: "/" },
  { name: "directory", url: "/posts/pagination/" },
  { name: "series", url: "/series/fixture-series/" },
] as const;

const WIDTHS = [390, 768, 1280, 1536] as const;

/** Read the boxes the browser actually produced. */
const MEASURE = `(() => {
  const rows = [...document.querySelectorAll(".index-row")];
  return JSON.stringify(
    rows.map((row) => {
      const band = row.querySelector(".index-row__thumb");
      const rowBox = row.getBoundingClientRect();
      const bandBox = band === null ? null : band.getBoundingClientRect();

      // Every element in the row that paints its own text.
      const texts = [];
      for (const el of row.querySelectorAll("*")) {
        if (band !== null && (el === band || band.contains(el))) continue;
        const paints = [...el.childNodes].some(
          (node) => node.nodeType === 3 && (node.textContent || "").trim().length > 0,
        );
        if (!paints) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        texts.push({ right: box.right, tag: el.tagName, cls: String(el.className) });
      }

      return {
        row: { top: rowBox.top, bottom: rowBox.bottom },
        band: bandBox === null ? null : { left: bandBox.left, top: bandBox.top, bottom: bandBox.bottom, width: bandBox.width },
        texts,
      };
    }),
  );
})()`;

interface Row {
  readonly row: { top: number; bottom: number };
  readonly band: {
    left: number;
    top: number;
    bottom: number;
    width: number;
  } | null;
  readonly texts: { right: number; tag: string; cls: string }[];
}

for (const width of WIDTHS) {
  test.describe(`cover band at ${width}px`, () => {
    for (const target of LIST_PAGES) {
      test(`${target.name}: text stays clear of the band and bands never touch`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await visit(page, target.url);

        const rows = JSON.parse(
          (await page.evaluate(MEASURE)) as string,
        ) as Row[];
        expect(
          rows.length,
          `no rows rendered on ${target.url}`,
        ).toBeGreaterThan(0);

        const problems: string[] = [];
        let previousBottom: number | null = null;

        for (const [index, entry] of rows.entries()) {
          if (entry.band === null) continue;

          // 1. No text may reach into the band. This is the check that would
          //    have caught the article-header version of this defect.
          for (const text of entry.texts) {
            if (text.right > entry.band.left) {
              problems.push(
                `row ${index}: <${text.tag.toLowerCase()} class="${text.cls}"> ends at ${Math.round(text.right)}, past the band's left edge at ${Math.round(entry.band.left)}`,
              );
            }
          }

          // 2. The band must sit inside its own row, or it will overlap the
          //    rows above and below it.
          if (
            entry.band.top < entry.row.top - 0.5 ||
            entry.band.bottom > entry.row.bottom + 0.5
          ) {
            problems.push(
              `row ${index}: band spans ${Math.round(entry.band.top)}–${Math.round(entry.band.bottom)} but the row is ${Math.round(entry.row.top)}–${Math.round(entry.row.bottom)}`,
            );
          }

          // 3. Consecutive bands must not touch, or the covers read as one
          //    continuous column with the separators lost inside it.
          if (previousBottom !== null && entry.band.top < previousBottom) {
            problems.push(
              `row ${index}: band starts at ${Math.round(entry.band.top)}, above the previous band's end at ${Math.round(previousBottom)}`,
            );
          }
          previousBottom = entry.band.bottom;
        }

        /*
         * 4. Every band is the same height.
         *
         * The band is capped by its own token, but it is also capped by the row
         * it sits in — and row height follows the title, so before the row
         * reserved the band's height the covers came out 50px on a one-line row
         * and 82px on a row whose tags wrapped. The right-hand edge of the list
         * was a ragged column. This asserts the fix rather than the mechanism.
         */
        const heights = rows
          .map((entry) => entry.band)
          .filter((band): band is NonNullable<typeof band> => band !== null)
          .map((band) => band.bottom - band.top);

        if (heights.length > 1) {
          const shortest = Math.min(...heights);
          const tallest = Math.max(...heights);
          if (tallest - shortest > 1) {
            problems.push(
              `cover heights are not uniform: shortest ${shortest.toFixed(1)}px, tallest ${tallest.toFixed(1)}px (${heights.map((h) => h.toFixed(1)).join(", ")})`,
            );
          }
        }

        /*
         * 5. The cover fills the row it sits in.
         *
         * This is what makes the band read as the row's cover rather than as a
         * thumbnail, and it is a property of the two together: the band is a
         * fixed size now, so the row has to be short enough for it to fill.
         *
         * The row's height is not one number — a title that wraps to two lines
         * makes a taller row than one that does not, which is intended; the row
         * grows and the cover does not. Asserting a ratio on every row would
         * therefore fail on a long title, which is content, not layout. So the
         * check is on the *shortest* row, which is the one with the least
         * content: if the cover fills that, it fills the rows whose extra height
         * comes from a longer title as well as those extra lines allow.
         *
         * The threshold is the band's own height plus its inset, over the
         * shortest row — comfortably met at 82% measured on a phone and 88% on a
         * desktop, and missed by a wide margin if the band ever shrinks back to
         * a thumbnail or a row grows a block of content it should not have.
         */
        if (heights.length > 0) {
          const banded = rows.filter((entry) => entry.band !== null);
          const shortestRow = Math.min(
            ...banded.map((entry) => entry.row.bottom - entry.row.top),
          );
          const bandHeight = Math.max(...heights);
          const fill = bandHeight / shortestRow;

          if (fill < 0.7) {
            problems.push(
              `the cover fills only ${(fill * 100).toFixed(1)}% of the shortest row at ${width}px (${bandHeight.toFixed(1)}px band in a ${shortestRow.toFixed(1)}px row) — it should fill the row, not sit inside it as a thumbnail`,
            );
          }
        }

        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  });
}

test.describe("cover band — rendering", () => {
  test("the band is masked so it dissolves rather than ending in a hard edge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, "/");

    const mask = await page
      .locator(".index-row__thumb [data-media-frame]")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return style.maskImage !== "none"
          ? style.maskImage
          : style.webkitMaskImage;
      });

    expect(mask).toContain("gradient");
  });

  test("the band does not intercept clicks meant for the row", async ({
    page,
  }) => {
    // The band is decoration; it is positioned over the row's trailing edge, so
    // a stray click there must still reach the row rather than being swallowed.
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, "/");

    const band = page.locator(".index-row__thumb").first();
    const pointerEvents = await band.evaluate(
      (element) => getComputedStyle(element).pointerEvents,
    );
    expect(pointerEvents).toBe("none");
  });

  test("the row's own links are still clickable and focusable", async ({
    page,
  }) => {
    await visit(page, "/");

    const link = page.locator(".index-row__title a").first();
    await link.focus();
    await expect(link).toBeFocused();

    await link.click();
    await expect(page).toHaveURL(/\/posts\//);
  });

  test("a failed cover degrades to the same-size panel, not a broken image", async ({
    page,
  }) => {
    // Every fixture cover points at the loopback media origin. This test alone
    // replaces those replies with 404s: the row must keep its geometry and
    // show the fallback panel.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route(`${MEDIA_ORIGIN}/**`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "text/plain; charset=utf-8",
        body: "",
      }),
    );
    await visit(page, "/");

    const firstBand = page.locator(".index-row__thumb").first();
    const before = await firstBand.boundingBox();

    await expect(
      firstBand.locator("[data-media-fallback]"),
      "the fallback panel should be showing",
    ).toBeVisible();

    const after = await firstBand.boundingBox();
    expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
    expect(after?.height).toBeCloseTo(before?.height ?? 0, 0);
  });
});
