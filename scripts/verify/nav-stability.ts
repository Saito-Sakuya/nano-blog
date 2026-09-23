import { chromium, type Browser } from "@playwright/test";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import {
  assertBuildExists,
  startStaticServer,
  stopStaticServer,
  waitForServer,
} from "./static-server.js";

/**
 * The header navigation must not move as you navigate.
 *
 * ## What this catches, and why nothing else does
 *
 * A classic scrollbar takes about 15px out of the viewport, so a page tall
 * enough to scroll is narrower than one that is not. Every container here is
 * centred with `margin-inline: auto`, so that difference shifts the whole
 * layout sideways — the header navigation included, even though nothing about
 * the navigation itself changed. Moving between a short page (`/about/`,
 * `/tags/`, `/search/`) and a long one (the feed, an article) moved the nav
 * almost 8px in each direction, which reads as the interface twitching under
 * the click.
 *
 * The fix is one line of CSS (`scrollbar-gutter: stable`), and the reason it
 * survived every existing check is worth recording: **a headless browser uses
 * overlay scrollbars**, which take no space, so `innerWidth - clientWidth` is
 * always 0 and the shift is not measurable there. Forcing `overflow-y: scroll`
 * in headless does not help either — it still costs no width. The defect only
 * exists in a browser with classic scrollbars, so the check has to run in one.
 *
 * This script therefore launches a **headed** browser and measures the nav's
 * position on pages with and without a scrollbar. If no display is available it
 * reports that it could not run rather than reporting success — a check that
 * silently passes when it cannot measure anything is worse than no check — the
 * same failure mode as the vacuous `markdownlint` step this suite once had,
 * which linted zero files and reported success.
 */

const BUILD_DIR = "dist-fixtures";
const PORT = 4360;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Pages chosen for the two states that matter.
 *
 * `scrolls` is asserted rather than assumed: if a page stops being long enough
 * to scroll, this check would compare two identical cases and pass without
 * testing anything.
 */
const PAGES: readonly {
  readonly name: string;
  readonly url: string;
  readonly scrolls: boolean;
}[] = [
  { name: "home", url: "/", scrolls: true },
  { name: "article", url: "/posts/notes/first-note/", scrolls: true },
  { name: "about", url: "/about/", scrolls: false },
  { name: "tags", url: "/tags/", scrolls: false },
  { name: "search", url: "/search/", scrolls: false },
  { name: "404", url: "/no-such-page-nav-check/", scrolls: false },
];

/** The nav's leading edge, plus the layout width it was computed against. */
const MEASURE = `(() => {
  const first = document.querySelector(".site-nav__list > li > .bookmark");
  const inner = document.querySelector(".site-header__inner");
  if (first === null || inner === null) return null;
  const innerBox = inner.getBoundingClientRect();
  return JSON.stringify({
    navLeft: first.getBoundingClientRect().left,
    innerLeft: innerBox.left,
    innerWidth: innerBox.width,
    viewportWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrolls:
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight,
  });
})()`;

interface Measurement {
  readonly navLeft: number;
  readonly innerLeft: number;
  readonly innerWidth: number;
  readonly viewportWidth: number;
  readonly clientWidth: number;
  readonly scrolls: boolean;
}

interface Sample extends Measurement {
  readonly name: string;
  readonly expectedToScroll: boolean;
}

/** Launch a headed browser, positioned off-screen so it does not interrupt. */
async function launchHeaded(): Promise<Browser> {
  return chromium.launch({
    channel: process.env["E2E_CHANNEL"] ?? "chrome",
    headless: false,
    args: [
      // Off-screen: this must run in a real window to have classic scrollbars,
      // but it should not steal the screen while it does.
      "--window-position=-32000,-32000",
      "--window-size=1280,900",
      // Neither a scrollbar-free viewport nor an overlay scrollbar would
      // reproduce the condition, so ask for the platform's default behaviour
      // explicitly rather than accepting a headless default.
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
}

async function collect(browser: Browser): Promise<Sample[]> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const samples: Sample[] = [];

  for (const target of PAGES) {
    await page.goto(`${BASE_URL}${target.url}`, { waitUntil: "load" });
    // The scrollbar decision is made at layout time; give the engine a frame to
    // settle before reading the boxes.
    await page.waitForTimeout(250);

    const raw = (await page.evaluate(MEASURE)) as string | null;
    if (raw === null) {
      throw new Error(
        `${target.url} did not render the header navigation; the measurement would be meaningless.`,
      );
    }

    samples.push({
      ...(JSON.parse(raw) as Measurement),
      name: target.name,
      expectedToScroll: target.scrolls,
    });
  }

  await context.close();
  return samples;
}

async function main(): Promise<number> {
  const root = PROJECT_ROOT;
  assertBuildExists(`${root}/${BUILD_DIR}`, BUILD_DIR);

  const server = await startStaticServer(`${root}/${BUILD_DIR}`, PORT);
  let browser: Browser | undefined;

  try {
    await waitForServer(`${BASE_URL}/`, 30_000);

    try {
      browser = await launchHeaded();
    } catch (error) {
      // No display, or no system Chrome. Say so plainly instead of reporting a
      // pass from a measurement that never happened.
      console.error(
        `nav-stability: SKIPPED — could not start a headed browser, so the scrollbar condition cannot be reproduced here.\n  ${error instanceof Error ? error.message : String(error)}\n  This check only has meaning in a browser with classic scrollbars; a headless one would compare two identical cases and always pass.`,
      );
      return 2;
    }

    const samples = await collect(browser);

    console.log("page     scrolls  viewport  client  navLeft");
    for (const sample of samples) {
      console.log(
        `${sample.name.padEnd(8)} ${String(sample.scrolls).padEnd(7)} ${String(sample.viewportWidth).padEnd(9)} ${String(sample.clientWidth).padEnd(7)} ${sample.navLeft.toFixed(2)}`,
      );
    }

    const failures: string[] = [];

    // The premise of the check: the sample really does contain both states.
    // Without this the script could pass by measuring six pages that all look
    // the same, which is exactly how the vacuous markdownlint step behaved.
    const scrolling = samples.filter((sample) => sample.scrolls);
    const notScrolling = samples.filter((sample) => !sample.scrolls);
    if (scrolling.length === 0 || notScrolling.length === 0) {
      failures.push(
        `the sample no longer contains both a scrolling and a non-scrolling page (${scrolling.length} vs ${notScrolling.length}), so this check cannot detect the shift it exists for`,
      );
    }

    for (const sample of samples) {
      if (sample.scrolls !== sample.expectedToScroll) {
        failures.push(
          `${sample.name} was expected to ${sample.expectedToScroll ? "" : "not "}scroll but ${sample.scrolls ? "does" : "does not"}; the sample needs updating`,
        );
      }
    }

    // The actual assertion: the nav sits in the same place in every state.
    const target = samples[0];
    if (target !== undefined) {
      for (const sample of samples) {
        const delta = Math.abs(sample.navLeft - target.navLeft);
        if (delta > 0.5) {
          failures.push(
            `${sample.name}: the nav sits at ${sample.navLeft.toFixed(2)} but ${target.name} has it at ${target.navLeft.toFixed(2)} — it moves by ${delta.toFixed(2)}px when the scrollbar appears or disappears`,
          );
        }
      }
    }

    if (failures.length > 0) {
      console.error(`\nnav-stability: FAIL\n  ${failures.join("\n  ")}`);
      return 1;
    }

    console.log(
      `\nnav-stability: PASS — the navigation holds its position across ${samples.length} page(s), with and without a scrollbar.`,
    );
    return 0;
  } finally {
    if (browser !== undefined) await browser.close();
    await stopStaticServer(server);
  }
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export { BASE_URL, BUILD_DIR, PAGES, PORT };
