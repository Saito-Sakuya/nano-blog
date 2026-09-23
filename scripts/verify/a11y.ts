import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import {
  assertBuildExists,
  startStaticServer,
  stopStaticServer,
  waitForServer,
} from "./static-server.js";

/**
 * Accessibility verification.
 *
 * Two halves, because axe only covers one of them:
 *
 * 1. **Automated rules.** axe-core runs against six pages that between them
 *    exercise every distinct document shape — the home page, an article, an
 *    MDX-components article, search, a directory index and the 404 document —
 *    in light *and* dark. Colour contrast is the reason both themes are
 *    scanned: axe resolves the computed colours, so a dark-mode-only contrast
 *    failure is invisible to a single-theme run.
 * 2. **Keyboard behaviour.** axe does not press keys. The three things the
 *    specification calls out and no static rule can see are asserted here
 *    directly: the skip link is the first stop and moves focus to `#main`; the
 *    theme menu opens from the keyboard, can be moved through by keyboard and
 *    closes on Escape with focus returned to its trigger; and the tab strip
 *    responds to arrow keys.
 *
 * Only `serious` and `critical` violations fail the run — that is the
 * specification's bar. `minor` and `moderate` findings are still recorded in
 * full in `lighthouse-results/a11y.json`, so "it passed" never means "nothing
 * was found".
 *
 * The fixture build is served by `./static-server.ts` on its own port — the
 * same server `test:e2e` and `test:visual` use, for the same reason: Astro 7
 * backgrounds `astro preview` under an agent and takes a lock no second caller
 * can acquire. The script is self-contained: it needs no server left running
 * and no particular working directory.
 */

const BUILD_DIR = "dist-fixtures";
const PORT = 4331;
const BASE_URL = `http://localhost:${PORT}`;
const REPORT_PATH = path.join(PROJECT_ROOT, "lighthouse-results", "a11y.json");

const THEME_STORAGE_KEY = "nano-blog-theme";

const PAGES: readonly {
  readonly name: string;
  readonly url: string;
  readonly note: string;
}[] = [
  { name: "home", url: "/", note: "the paginated list" },
  {
    name: "article",
    url: "/posts/notes/first-note/",
    note: "the full Markdown capability set",
  },
  {
    name: "mdx-components",
    url: "/posts/notes/components/",
    note: "tabs, callouts, embeds",
  },
  { name: "search", url: "/search/", note: "Pagefind-driven UI" },
  {
    name: "directory-index",
    url: "/posts/notes/",
    note: "an auto-generated directory index",
  },
  {
    name: "not-found",
    url: "/no-such-page-a11y-check/",
    note: "the standalone 404 document",
  },
];

/** The pages that grow floating rails below the wide breakpoint. */
const NARROW_PAGES: readonly { readonly name: string; readonly url: string }[] =
  [
    { name: "article", url: "/posts/notes/first-note/" },
    { name: "toc-always", url: "/posts/notes/toc-always/" },
  ];

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const FAILING_IMPACTS: readonly string[] = ["serious", "critical"];

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

interface PageScan {
  readonly page: string;
  readonly url: string;
  readonly theme: Theme;
  readonly violations: readonly {
    readonly id: string;
    readonly impact: string;
    readonly help: string;
    readonly nodes: number;
    readonly targets: readonly string[];
  }[];
  readonly incomplete: readonly {
    readonly id: string;
    readonly impact: string;
    readonly help: string;
    readonly targets: readonly string[];
  }[];
}

interface KeyboardCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

function startPreview(): Promise<Server> {
  return startStaticServer(path.join(PROJECT_ROOT, BUILD_DIR), PORT);
}

function summarise(results: AxeResults): PageScan["violations"] {
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? "unknown",
    help: violation.help,
    nodes: violation.nodes.length,
    targets: violation.nodes
      .slice(0, 5)
      .map((node) => node.target.map((part) => String(part)).join(" ")),
  }));
}

/** Tab until the given selector holds focus, or give up. */
async function tabTo(
  page: Page,
  selector: string,
  limit: number,
): Promise<boolean> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate((query) => {
      const active = document.activeElement;
      return active !== null && active.matches(query);
    }, selector);
    if (focused) return true;
  }
  return false;
}

/**
 * The keyboard assertions axe cannot make.
 *
 * Each one is written against the real markup the site ships — `.skip-link`,
 * `[data-theme-button]`/`[data-theme-menu]`, `[role="tab"]` — so it fails if
 * the component changes shape, not merely if a style changes.
 */
async function keyboardChecks(browser: Browser): Promise<KeyboardCheck[]> {
  const checks: KeyboardCheck[] = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    // --- 1. the skip link is the first stop --------------------------------
    await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
    await page.keyboard.press("Tab");

    const firstStop = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        className: active?.className ?? "",
        tag: active?.tagName ?? "",
        text: active?.textContent?.trim() ?? "",
      };
    });
    const skipLinkFirst = firstStop.className.includes("skip-link");
    checks.push({
      name: "skip link is the first focusable element",
      passed: skipLinkFirst,
      detail: `first stop was <${firstStop.tag} class="${firstStop.className}">${firstStop.text}</${firstStop.tag}>`,
    });

    // --- 2. the skip link moves focus to the main region --------------------
    await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const mainFocused = await page.evaluate(
      () => document.activeElement?.id === "main",
    );
    checks.push({
      name: "skip link moves focus to #main",
      passed: mainFocused,
      detail: "activated the skip link and read document.activeElement.id",
    });

    // --- 3. the theme menu is operable from the keyboard --------------------
    await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
    const reached = await tabTo(page, "[data-theme-button]", 24);

    if (!reached) {
      checks.push({
        name: "theme menu is operable by keyboard",
        passed: false,
        detail: "the theme button was not reachable by 24 Tab presses",
      });
    } else {
      await page.keyboard.press("Enter");
      const openedByEnter = await page.locator("[data-theme-menu]").isVisible();

      const movedByArrow = await (async (): Promise<boolean> => {
        if (!openedByEnter) return false;
        await page.keyboard.press("ArrowDown");
        return page.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute("role") === "menuitemradio";
        });
      })();

      checks.push({
        name: "theme menu opens from the keyboard and moves by arrow key",
        passed: openedByEnter && movedByArrow,
        detail: `Enter opened the menu: ${String(openedByEnter)}; ArrowDown focused a menuitemradio: ${String(movedByArrow)}`,
      });

      await page.keyboard.press("Escape");
      const closedOnEscape = await page.locator("[data-theme-menu]").isHidden();
      const focusReturned = await page.evaluate(
        () =>
          document.activeElement?.hasAttribute("data-theme-button") === true,
      );
      checks.push({
        name: "theme menu closes on Escape and returns focus to its trigger",
        passed: closedOnEscape && focusReturned,
        detail: `hidden: ${String(closedOnEscape)}; focus returned: ${String(focusReturned)}`,
      });
    }

    // --- 4. tabs respond to arrow keys --------------------------------------
    await page.goto(`${BASE_URL}/posts/notes/components/`, {
      waitUntil: "load",
    });
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();

    if (tabCount < 2) {
      checks.push({
        name: "tabs respond to arrow keys",
        passed: false,
        detail: `the components article exposed ${tabCount} tab(s)`,
      });
    } else {
      await tabs.first().click();
      await page.keyboard.press("ArrowRight");
      const advanced = await tabs.nth(1).getAttribute("aria-selected");

      await page.keyboard.press("ArrowLeft");
      const returned = await tabs.first().getAttribute("aria-selected");

      checks.push({
        name: "tabs respond to arrow keys",
        passed: advanced === "true" && returned === "true",
        detail: `ArrowRight selected the second tab: ${String(advanced === "true")}; ArrowLeft selected the first again: ${String(returned === "true")}`,
      });
    }

    /*
     * --- 5. the note marker is operable from the keyboard -------------------
     *
     * The marker is the visible way into a sidenote below the wide breakpoint,
     * and it is a new control, so "a control no scan has ever driven" applies to
     * it in the keyboard sense too. Two things are asserted: it can be reached
     * and activated by keyboard, and Escape gives the focus back to it rather
     * than dropping the reader at the top of the document.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/posts/notes/first-note/`, {
      waitUntil: "load",
    });
    await page.waitForTimeout(400);

    const markerReached = await tabTo(page, ".sidenote-chip", 40);
    if (!markerReached) {
      checks.push({
        name: "the note marker is reachable by keyboard",
        passed: false,
        detail: "tabbed 40 times without reaching .sidenote-chip",
      });
    } else {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      const openedByKeyboard = await page.evaluate(
        () =>
          document
            .querySelector("[data-sidenote-rail]")
            ?.hasAttribute("open") === true,
      );

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const restored = await page.evaluate(() => ({
        closed:
          document
            .querySelector("[data-sidenote-rail]")
            ?.hasAttribute("open") === false,
        focusClass: document.activeElement?.className ?? "",
      }));

      checks.push({
        name: "the note marker opens a note and Escape returns focus to it",
        passed:
          openedByKeyboard &&
          restored.closed &&
          restored.focusClass === "sidenote-chip",
        detail: `Enter opened the drawer: ${String(openedByKeyboard)}; Escape closed it: ${String(restored.closed)}; focus was on "${restored.focusClass}"`,
      });
    }
  } finally {
    await context.close();
  }

  return checks;
}

async function main(): Promise<number> {
  const root = path.join(PROJECT_ROOT, BUILD_DIR);
  assertBuildExists(root, BUILD_DIR);

  console.log(`serving ${BUILD_DIR} on ${BASE_URL}`);
  const server = await startPreview();

  let browser: Browser | undefined;
  const scans: PageScan[] = [];

  try {
    await waitForServer(`${BASE_URL}/`, 60_000);
    browser = await chromium.launch({
      channel: process.env["E2E_CHANNEL"] ?? "chrome",
    });

    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      await context.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key as string, value as string);
          } catch {
            // Storage can be blocked; the default theme then applies.
          }
        },
        [THEME_STORAGE_KEY, theme],
      );

      const page = await context.newPage();

      for (const target of PAGES) {
        await page.goto(`${BASE_URL}${target.url}`, { waitUntil: "load" });
        await page.waitForTimeout(200);

        const applied = await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        );
        if (applied !== theme) {
          throw new Error(
            `${target.url}: asked for the ${theme} theme but the document says ${JSON.stringify(applied)}.`,
          );
        }

        const results = await new AxeBuilder({ page }).analyze();
        scans.push({
          page: target.name,
          url: target.url,
          theme,
          violations: summarise(results),
          incomplete: results.incomplete.map((item) => ({
            id: item.id,
            impact: item.impact ?? "unknown",
            help: item.help,
            targets: item.nodes
              .slice(0, 5)
              .map((node) => node.target.map((part) => String(part)).join(" ")),
          })),
        });

        const failing = results.violations.filter((violation) =>
          FAILING_IMPACTS.includes(violation.impact ?? ""),
        );
        console.log(
          `${target.name} (${theme}): ${results.violations.length} violation(s), ${failing.length} at serious/critical`,
        );
      }

      await context.close();
    }

    /*
     * A narrow pass, because some things only exist there.
     *
     * The floating contents and sidenote rails are created by script below the
     * wide breakpoint; at 1280px the rail element is hidden and the note is a
     * plain float in the margin, so a scan at that width never sees the drawer,
     * its summary or the reference links that open it. A control that no scan
     * has ever rendered is a control nobody has checked.
     *
     * Only the two pages that have rails, and only in the light theme: this is
     * an additional pass over new surface, not a second full matrix.
     */
    for (const target of NARROW_PAGES) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}${target.url}`, { waitUntil: "load" });
      await page.waitForTimeout(400);

      /*
       * Both states are scanned. A closed `<details>` renders only its summary,
       * so scanning the initial state audits the tabs and nothing else; opening
       * them is what puts the list, the note text and the drawer itself in front
       * of axe.
       */
      for (const state of ["closed", "open"] as const) {
        if (state === "open") {
          /*
           * The contents tab is a control on screen, so it is clicked.
           *
           * The note drawer is not: it has no tab, and stays `hidden` until one
           * of its references in the prose is clicked. Clicking the summary
           * would therefore do nothing — the drawer is not visible, so the
           * visibility check below skips it and the note text is never put in
           * front of axe at all. That is the coverage this pass exists for, so
           * the drawer is opened the way a reader opens it.
           *
           * A page with no notes has no reference to click, and a page whose
           * toc is hidden has no tab; both checks are for visibility, because
           * presence is what made this pass hang once already.
           */
          const tocTab = page.locator("[data-toc] > summary");
          if (await tocTab.isVisible()) await tocTab.click();

          const ref = page.locator(".sidenote-ref").first();
          if ((await ref.count()) > 0 && (await ref.isVisible())) {
            await ref.click();
          }
          await page.waitForTimeout(300);
        }

        const results = await new AxeBuilder({ page }).analyze();
        scans.push({
          page: `${target.name} narrow (${state})`,
          url: target.url,
          theme: "light",
          violations: summarise(results),
          incomplete: results.incomplete.map((item) => ({
            id: item.id,
            impact: item.impact ?? "unknown",
            help: item.help,
            targets: item.nodes
              .slice(0, 5)
              .map((node) => node.target.map((part) => String(part)).join(" ")),
          })),
        });

        const failing = results.violations.filter((violation) =>
          FAILING_IMPACTS.includes(violation.impact ?? ""),
        );
        console.log(
          `${target.name} narrow (${state}): ${results.violations.length} violation(s), ${failing.length} at serious/critical`,
        );
      }

      await context.close();
    }

    const keyboard = await keyboardChecks(browser);
    for (const check of keyboard) {
      console.log(
        `keyboard: ${check.passed ? "PASS" : "FAIL"} — ${check.name}`,
      );
    }

    const failingViolations = scans.flatMap((scan) =>
      scan.violations
        .filter((violation) => FAILING_IMPACTS.includes(violation.impact))
        .map((violation) => ({
          ...violation,
          page: scan.page,
          theme: scan.theme,
        })),
    );
    const failingKeyboard = keyboard.filter((check) => !check.passed);

    const byImpact: Record<string, number> = {};
    for (const scan of scans) {
      for (const violation of scan.violations) {
        byImpact[violation.impact] = (byImpact[violation.impact] ?? 0) + 1;
      }
    }

    const report = {
      generatedBy: "scripts/verify/a11y.ts",
      build: BUILD_DIR,
      baseUrl: BASE_URL,
      failingImpacts: FAILING_IMPACTS,
      pages: PAGES,
      themes: THEMES,
      scannedPages: scans.length,
      violationCountsByImpact: byImpact,
      scans,
      keyboard,
      failingViolations,
      passed: failingViolations.length === 0 && failingKeyboard.length === 0,
    };

    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(
      REPORT_PATH,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `report written to ${path.relative(PROJECT_ROOT, REPORT_PATH)}`,
    );

    if (report.passed) {
      console.log(
        `\na11y: PASS — no serious or critical violation across ${scans.length} scan(s), and every keyboard assertion holds.`,
      );
      return 0;
    }

    console.error("\na11y: FAIL");
    for (const violation of failingViolations) {
      console.error(
        `  [${violation.impact}] ${violation.id} on ${violation.page} (${violation.theme}): ${violation.help}`,
      );
      for (const target of violation.targets) console.error(`      ${target}`);
    }
    for (const check of failingKeyboard) {
      console.error(`  [keyboard] ${check.name}: ${check.detail}`);
    }
    return 1;
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

export { BASE_URL, BUILD_DIR, PAGES, PORT, THEMES };
