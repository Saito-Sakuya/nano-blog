import sharp from "sharp";

import { expect, test, visit } from "./fixtures.js";

/**
 * Text over the article cover must stay legible.
 *
 * On a wide screen the cover is lifted behind the article header and masked so
 * it dissolves towards the left, and the title, description and metadata sit in
 * the part that has faded out. That arrangement is legible by construction —
 * unless the two halves drift apart, which is what happened once: the text was
 * unbounded while the clear region was a fixed percentage of the header, so a
 * long title and the tail of the metadata row ended up on saturated parts of
 * the image at 2.8:1 and 1.4:1 contrast.
 *
 * Neither automated gate can see that:
 *
 * - axe and Lighthouse compute contrast from the element's own colour and its
 *   ancestors' background colours. A photograph is not a background colour, so
 *   the text is measured against the page behind it and passes;
 * - the screenshot comparison only looks at geometry and ink coverage.
 *
 * So this test measures the composite: it samples the rendered pixels underneath
 * each text run with the text hidden, and asserts the contrast ratio against the
 * colour the browser actually paints that text in.
 *
 * ## The cover is supplied by this test
 *
 * The fixture article is used because its title is deliberately long — it is
 * the case that exposes the problem — but its real cover comes from the media
 * bucket, which does not resolve here, and a fallback panel would make the
 * measurement meaningless. So the test intercepts the cover request and answers
 * with an image of its own making: the most hostile content the arrangement can
 * face, pure saturated blocks chosen so that no text colour can be legible over
 * them. If any text lands on the image rather than in the masked-out region,
 * the ratio collapses and the test fails, whatever the real cover looks like.
 *
 * That also makes the assertion independent of the fixture media and stable
 * across runs, which a photograph would not be.
 */

/*
 * The suite runs twice: once against the fixture build and once against the
 * empty one. This file needs the fixture build, because the empty build has no
 * article to look at — the same guard `content.spec.ts` uses.
 */
const EMPTY_BUILD = process.env["E2E_EMPTY"] === "1";

test.skip(EMPTY_BUILD, "the empty build has no content to exercise");

/*
 * This file decodes a screenshot and walks its pixels, which is heavier than a
 * DOM assertion and noticeably slower under WebKit. The default 30-second
 * budget is not enough there, and a timeout mid-test is worse than a slow pass:
 * it can leave the engine in a state where the tests after it fail too.
 */
test.setTimeout(120_000);

/** Wide-screen fixture article with a long title and a full metadata row. */
const ARTICLE = "/posts/notes/first-note/";

/** The width the defect first appeared at, and one wider than the measure. */
const WIDTHS = [1280, 1536];

/** WCAG 2.2 AA: 3:1 for large text, 4.5:1 for everything else. */
const LARGE_TEXT_RATIO = 3;
const BODY_TEXT_RATIO = 4.5;

interface Run {
  readonly label: string;
  readonly color: string;
  readonly large: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Text runs in the article header, in document order. */
const COLLECT_RUNS = `(() => {
  const runs = [];
  const add = (label, el, large) => {
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    runs.push({
      label,
      color: getComputedStyle(el).color,
      large,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  };

  add("title", document.querySelector(".article-head h1"), true);
  add("description", document.querySelector(".article-head__description"), false);

  const meta = document.querySelector(".article-meta");
  if (meta !== null) {
    [...meta.children].forEach((child, index) => {
      const link = child.tagName === "UL" ? child.querySelector("a") : child;
      const label = "meta[" + index + "] " + (child.textContent || "").trim().slice(0, 20);
      add(label, link, false);
    });
  }

  return JSON.stringify(runs);
})()`;

/**
 * Hide the header text so the screenshot is the bare backdrop.
 *
 * `visibility` rather than `display`, so nothing reflows and every run keeps
 * the geometry it was measured at.
 */
const HIDE_TEXT =
  ".article-head > *:not(.article-cover) { visibility: hidden !important; }";

/**
 * A cover built to be impossible to read text over: three fully saturated
 * bands, each a different hue, so no single text colour can clear 4.5:1 across
 * the width. Rendered as a 16:9 PNG to match the shape of the derivatives.
 */
async function hostileCover(): Promise<Buffer> {
  const width = 1024;
  const height = 576;
  const band = Math.round(width / 3);

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      {
        input: {
          create: {
            width: band,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 255, alpha: 1 },
          },
        },
        left: band,
        top: 0,
      },
      {
        input: {
          create: {
            width: band,
            height,
            channels: 4,
            background: { r: 0, g: 255, b: 0, alpha: 1 },
          },
        },
        left: band * 2,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

function parseColor(value: string): { r: number; g: number; b: number } {
  const match = /rgba?\(([^)]+)\)/u.exec(value);
  if (match === null || match[1] === undefined) {
    throw new Error(`Unparsable colour: ${value}`);
  }
  const parts = match[1]
    .split(/[,\s/]+/u)
    .filter((part) => part.length > 0)
    .map(Number);
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
}

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [high, low] = la > lb ? [la, lb] : [lb, la];
  return (high + 0.05) / (low + 0.05);
}

for (const width of WIDTHS) {
  test.describe(`article cover at ${width}px`, () => {
    test("every header text run keeps its contrast over the image", async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await visit(page, ARTICLE);

      /*
       * Substitute the cover after load rather than by intercepting the request.
       *
       * Replacing that with a page-level route would couple this test to route
       * precedence. Swapping the element's source sidesteps the question
       * entirely, and it also narrows what this test is about: the CSS
       * arrangement — the mask against the text column — rather than the
       * build's media wiring, which `content:validate` and the link checker
       * cover.
       *
       * `srcset` and the `<source>` siblings are removed first, because a
       * browser that has already picked a candidate from them will not fall back
       * to `src`.
       */
      const dataUrl = `data:image/png;base64,${(await hostileCover()).toString("base64")}`;
      await page.evaluate(`(() => {
        const image = document.querySelector(".article-cover img");
        if (image === null) throw new Error("no cover image in the header");

        // This test owns the source, so clear any state left by a previously
        // selected candidate before making the replacement visible. The point
        // is the masked-cover arrangement, not a media fallback state.
        const frame = image.closest("[data-media-frame]");
        if (frame !== null) {
          frame.removeAttribute("data-state");
          image.removeAttribute("aria-hidden");
        }

        for (const source of document.querySelectorAll(".article-cover source")) source.remove();
        image.removeAttribute("srcset");
        image.src = ${JSON.stringify(dataUrl)};
      })()`);

      // Wait for the substituted image to decode, so the sampled backdrop is it
      // rather than the fallback panel. The check is only that pixels arrived:
      // `naturalWidth` is reported in CSS pixels after the engine applies its
      // own density handling, so it is not the pixel size that was encoded.
      await page.waitForFunction(() => {
        const image =
          document.querySelector<HTMLImageElement>(".article-cover img");
        return image !== null && image.complete && image.naturalWidth > 0;
      });
      await page.waitForTimeout(150);

      const runs = JSON.parse(
        (await page.evaluate(COLLECT_RUNS)) as string,
      ) as Run[];
      expect(runs.length).toBeGreaterThan(3);

      await page.addStyleTag({ content: HIDE_TEXT });

      /*
       * Confirm the text is actually hidden before sampling.
       *
       * If this style has not been applied yet, the screenshot still contains
       * the glyphs and the sampling can land on one — which reports a contrast
       * of 1.00:1 against the text's own colour and looks like a page defect
       * when it is a race in the test.
       */
      await page.waitForFunction(() => {
        const title = document.querySelector(".article-head h1");
        return (
          title !== null && getComputedStyle(title).visibility === "hidden"
        );
      });

      // Only the header is sampled, so the capture stays small and the pixel
      // walk is bounded by the header's height rather than the page's.
      const headerBox = await page.locator(".article-head").boundingBox();
      if (headerBox === null) throw new Error("no article header to sample");

      // The runs are in page coordinates; the capture is the header only.
      const originX = Math.max(0, Math.floor(headerBox.x));
      const originY = Math.max(0, Math.floor(headerBox.y));

      /*
       * Captured with a retry, because WebKit occasionally hands back an empty
       * buffer.
       *
       * This is a capture problem, not a rendering one: the same test passes in
       * isolation at the same viewport, and the failure appears only when the
       * engine has been running for a long while — the full suite's WebKit
       * project starts after roughly half an hour of other work. `sharp` then
       * fails with "Input Buffer is empty" on a screenshot that was never taken.
       *
       * Retrying is the honest fix: the assertion is unchanged, the page is
       * re-captured, and an engine that genuinely cannot produce a raster fails
       * on the last attempt with the error rather than a silently empty image.
       */
      const captureHeader = async (): Promise<Buffer> => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const shot = await page.screenshot({
            clip: {
              x: Math.max(0, Math.floor(headerBox.x)),
              y: Math.max(0, Math.floor(headerBox.y)),
              width: Math.ceil(headerBox.width),
              height: Math.ceil(headerBox.height),
            },
          });
          if (shot.byteLength > 0) return shot;
          await page.waitForTimeout(250);
        }
        throw new Error(
          "the page produced an empty screenshot three times; the capture itself failed rather than the layout",
        );
      };

      const backdrop = await captureHeader();
      const { data, info } = await sharp(backdrop)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const channels = info.channels;

      const sampleAt = (x: number, y: number): [number, number, number] => {
        const px = Math.min(info.width - 1, Math.max(0, Math.round(x)));
        const py = Math.min(info.height - 1, Math.max(0, Math.round(y)));
        const offset = (py * info.width + px) * channels;
        return [
          data[offset] ?? 0,
          data[offset + 1] ?? 0,
          data[offset + 2] ?? 0,
        ];
      };

      const failures: string[] = [];

      for (const run of runs) {
        const foreground = parseColor(run.color);
        const required = run.large ? LARGE_TEXT_RATIO : BODY_TEXT_RATIO;

        // Sample across the run, because the mask fades along the x axis: the
        // right-hand end of a long line sits on more of the image than the
        // left-hand end does.
        const fractions = [0.05, 0.25, 0.5, 0.75, 0.95, 1];
        let worst = Number.POSITIVE_INFINITY;
        let worstSample: [number, number, number] = [0, 0, 0];

        for (const fraction of fractions) {
          const x = run.x + run.width * fraction - originX;
          const y = run.y + run.height / 2 - originY;
          const pixel = sampleAt(x, y);
          const ratio = contrastRatio(foreground, {
            r: pixel[0],
            g: pixel[1],
            b: pixel[2],
          });
          if (ratio < worst) {
            worst = ratio;
            worstSample = pixel;
          }
        }

        if (worst < required) {
          const hex = (c: readonly number[]): string =>
            `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const foregroundHex = hex([foreground.r, foreground.g, foreground.b]);
          failures.push(
            `${run.label}: ${worst.toFixed(2)}:1 over ${hex(worstSample)} (needs ${required}:1, text ${foregroundHex})`,
          );
        }
      }

      expect(failures, failures.join("\n")).toEqual([]);
    });
  });
}
