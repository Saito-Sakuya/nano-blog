import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
 * Visual acceptance screenshots.
 *
 * Four viewports — 360×800, 768×1024, 1280×900, 1536×960 — against five pages
 * that between them cover every layout the site has:
 *
 * | Page             | URL                            | Why                                   |
 * | ---------------- | ------------------------------ | ------------------------------------- |
 * | home             | `/`                            | the densest list, cover images, pager  |
 * | article          | `/posts/notes/first-note/`     | the full Markdown/MDX capability set  |
 * | deep directory   | `/posts/dev/web/deep/nested/`  | three levels of breadcrumb and index  |
 * | search           | `/search/`                     | the only page that loads Pagefind     |
 * | 404              | an unknown path                | the standalone document               |
 *
 * Each is captured in light and dark, which is 40 PNGs. The theme is set
 * through the site's own mechanism — the `nano-blog-theme` key in
 * `localStorage`, written before any page script runs — so the screenshot
 * shows what a reader who chose that theme actually sees, including the
 * pre-paint attribute. The attribute is asserted afterwards; a screenshot that
 * silently came out in the wrong theme would be worse than no screenshot.
 *
 * The build is served by the same small static server the browser suite uses —
 * directory URLs resolve to their `index.html`, anything else to `404.html`
 * with a 404 status — because that is what Cloudflare Pages does for this
 * build, and because `astro preview` cannot be relied on here: Astro 7 moves it
 * into the background under an agent and takes a global lock that a second
 * caller cannot acquire. Serving the files directly also means the screenshots
 * show the build as deployed rather than as a preview server would present it.
 *
 * The media bucket (`media.example.invalid`) is a Cloudflare resource this
 * repository is forbidden from creating and does not resolve locally. Covers
 * therefore render their fallback panels in every screenshot; that is the
 * documented degradation, and the layout it produces is what these images are
 * for.
 */

const VIEWPORTS: readonly {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}[] = [
  { label: "360x800", width: 360, height: 800 },
  { label: "768x1024", width: 768, height: 1024 },
  { label: "1280x900", width: 1280, height: 900 },
  { label: "1536x960", width: 1536, height: 960 },
];

const PAGES: readonly { readonly name: string; readonly url: string }[] = [
  { name: "home", url: "/" },
  { name: "article", url: "/posts/notes/first-note/" },
  { name: "deep-directory", url: "/posts/dev/web/deep/nested/" },
  { name: "search", url: "/search/" },
  { name: "not-found", url: "/no-such-page-visual-check/" },
];

const THEMES = ["light", "dark"] as const;

const BUILD_DIR = "dist-fixtures";
const PORT = 4330;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(PROJECT_ROOT, "lighthouse-results", "screenshots");

/** The key the site's own pre-paint script reads. */
const THEME_STORAGE_KEY = "nano-blog-theme";

async function main(): Promise<number> {
  const root = path.join(PROJECT_ROOT, BUILD_DIR);
  assertBuildExists(root, BUILD_DIR);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`serving ${BUILD_DIR} on ${BASE_URL}`);
  const server = await startStaticServer(root, PORT);

  let browser: Browser | undefined;
  const written: string[] = [];

  try {
    await waitForServer(`${BASE_URL}/`, 60_000);

    browser = await chromium.launch({
      channel: process.env["E2E_CHANNEL"] ?? "chrome",
    });

    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        // The site's own storage key, written before any page script runs.
        // `addInitScript` is the only way to be earlier than the blocking
        // `/theme-init.js` in `<head>`.
        await context.addInitScript(
          ([key, value]) => {
            try {
              window.localStorage.setItem(key as string, value as string);
            } catch {
              // Storage can be blocked; the page then follows the system.
            }
          },
          [THEME_STORAGE_KEY, theme],
        );

        const page = await context.newPage();

        for (const target of PAGES) {
          await page.goto(`${BASE_URL}${target.url}`, { waitUntil: "load" });

          const applied = await page.evaluate(() =>
            document.documentElement.getAttribute("data-theme"),
          );
          if (applied !== theme) {
            throw new Error(
              `${target.url} at ${viewport.label}: asked for ${theme}, the document says ${JSON.stringify(applied)}. The pre-paint theme script did not apply the stored choice.`,
            );
          }

          // Let images settle into their loaded or failed state so the fallback
          // panels are captured rather than a half-initialised frame.
          await page.waitForTimeout(250);

          const file = path.join(
            OUTPUT_DIR,
            `${target.name}__${viewport.label}__${theme}.png`,
          );
          await page.screenshot({
            path: file,
            fullPage: true,
            animations: "disabled",
          });
          written.push(
            path.relative(PROJECT_ROOT, file).split(path.sep).join("/"),
          );
        }

        await context.close();
        console.log(
          `captured ${PAGES.length} page(s) at ${viewport.label} in ${theme}`,
        );
      }
    }
  } finally {
    if (browser !== undefined) await browser.close();
    await stopStaticServer(server);
  }

  const manifest = {
    generatedBy: "scripts/verify/visual.ts",
    build: BUILD_DIR,
    baseUrl: BASE_URL,
    viewports: VIEWPORTS,
    pages: PAGES,
    themes: THEMES,
    screenshots: written.sort(),
  };
  await writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const onDisk = (await readdir(OUTPUT_DIR))
    .filter((name) => name.endsWith(".png"))
    .sort();

  console.log(
    `\n${onDisk.length} screenshot(s) in ${path.relative(PROJECT_ROOT, OUTPUT_DIR)}:`,
  );
  for (const name of onDisk) console.log(`  ${name}`);

  const expected = VIEWPORTS.length * PAGES.length * THEMES.length;
  if (onDisk.length !== expected) {
    console.error(
      `\nvisual: FAIL — expected ${expected} screenshots, found ${onDisk.length}.`,
    );
    return 1;
  }

  console.log(
    `\nvisual: PASS — ${expected} screenshots across 4 viewports, 5 pages, 2 themes.`,
  );
  return 0;
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

export { BASE_URL, BUILD_DIR, PAGES, PORT, THEMES, VIEWPORTS };
