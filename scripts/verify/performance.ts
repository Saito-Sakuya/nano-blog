import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";

/**
 * Resource budget verification.
 *
 * The budget is measured against the files the build actually emitted, not
 * against a bundler report and not against a synthetic estimate. Only the
 * resources a page loads on its **first screen** are counted:
 *
 * | Resource                    | Budget   |
 * | --------------------------- | -------- |
 * | client JS, ordinary article | 50 KB gz |
 * | client JS, home page        | 100 KB gz |
 * | first-load CSS              | 40 KB gz |
 * | web fonts                   | 0 bytes  |
 *
 * "First-load" is read strictly:
 *
 * - every `<script src>` the document names, plus every module those scripts
 *   import statically (a module graph is not free just because the entry is
 *   small), plus every `<link rel="modulepreload">`;
 * - every `<link rel="stylesheet">`, including the `media="print"` one, because
 *   a browser fetches it as part of the page load;
 * - the font files those stylesheets' `@font-face` rules resolve to, and any
 *   `<link rel="preload" as="font">`.
 *
 * The ordinary-article figure is the largest first-load JS across every
 * article that contains no diagram, no embed and no formula — the worst case
 * among pages that have no excuse to be heavy. Articles that do contain a
 * diagram are reported too, but against no budget: the Mermaid
 * and KaTeX bundles to be *split and loaded only there*, which is a shape
 * requirement, and their size is the dependency's, not the site's.
 */

const BUDGET = {
  /** Budget: an ordinary article's first-screen client JS. */
  articleJsBytes: 50 * 1024,
  /** Budget: the home page's first-screen client JS. */
  homeJsBytes: 100 * 1024,
  /** Budget: first-screen CSS. */
  cssBytes: 40 * 1024,
  /** Budget: web fonts. KaTeX's are loaded only by pages containing a formula. */
  fontBytes: 0,
} as const;

const REPORT_DIR = path.join(PROJECT_ROOT, "lighthouse-results");
const REPORT_PATH = path.join(REPORT_DIR, "budget.json");

interface Resource {
  /** Path relative to the build root. */
  readonly relative: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  /** Why this file is in the set, for the report. */
  readonly reason: string;
}

interface PageMeasurement {
  readonly build: string;
  readonly url: string;
  readonly file: string;
  readonly scripts: readonly Resource[];
  readonly stylesheets: readonly Resource[];
  readonly fonts: readonly Resource[];
  readonly jsGzip: number;
  readonly cssGzip: number;
  readonly fontGzip: number;
  readonly hasDiagram: boolean;
  readonly hasFormula: boolean;
  readonly hasEmbed: boolean;
}

interface BudgetViolation {
  readonly label: string;
  readonly measured: number;
  readonly budget: number;
  readonly detail: string;
}

/**
 * POSIX-relative path of a build file, from a URL path or relative specifier.
 *
 * The query string and fragment are dropped first. A `<link href>` may carry
 * either — KaTeX's stylesheet is versioned by a digest in `?v=`, which is how a
 * cache-busting URL is normally spelled — and treating `katex.min.css?v=abc` as
 * a path made this script look for a file with a question mark in its name and
 * report the stylesheet as missing from a build that contains it.
 */
function toRelative(urlPath: string): string {
  const withoutQuery = urlPath.split(/[?#]/u)[0] ?? urlPath;
  return withoutQuery.replace(/^\/+/u, "");
}

async function gzipSizeOf(absolute: string): Promise<number> {
  return gzipSync(await readFile(absolute)).byteLength;
}

async function resourceOf(
  root: string,
  relative: string,
  reason: string,
): Promise<Resource | null> {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return null;
  return {
    relative,
    bytes: (await readFile(absolute)).byteLength,
    gzipBytes: await gzipSizeOf(absolute),
    reason,
  };
}

/** Every `href` on `<link>` elements with the given `rel`, plus their `as`. */
function collectLinks(
  html: string,
): { rel: string; href: string; as: string }[] {
  const links: { rel: string; href: string; as: string }[] = [];

  visit(fromHtml(html, { fragment: true }), "element", (node) => {
    if (node.tagName !== "link") return;
    const href = node.properties["href"];
    if (typeof href !== "string" || !href.startsWith("/")) return;
    const rel = node.properties["rel"];
    const as = node.properties["as"];
    links.push({
      rel: Array.isArray(rel)
        ? rel.join(" ")
        : typeof rel === "string"
          ? rel
          : "",
      href,
      as: typeof as === "string" ? as : "",
    });
  });

  return links;
}

/** Every `<script src="...">` the document names, in order. */
function collectScriptSources(html: string): string[] {
  const sources: string[] = [];

  visit(fromHtml(html, { fragment: true }), "element", (node) => {
    if (node.tagName !== "script") return;
    const src = node.properties["src"];
    if (typeof src === "string" && src.startsWith("/")) sources.push(src);
  });

  return sources;
}

/** True when the document contains an `<iframe>` (an embed loads on click). */
function hasIframe(html: string): boolean {
  let found = false;
  visit(fromHtml(html, { fragment: true }), "element", (node) => {
    if (node.tagName === "iframe") found = true;
  });
  return found;
}

/**
 * Static and dynamic `import` specifiers in a built JavaScript module.
 *
 * Astro emits ES modules and Vite rewrites every specifier to a relative path
 * in the same directory, so a specifier is resolved against the importing
 * file. Only file specifiers are followed; a bare specifier cannot occur in
 * the output.
 */
function importsIn(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|[^\w$.])import\s*(?:[\w*{},\s$]*)from\s*["']([^"']+)["']/gu,
    /(?:^|[^\w$.])import\s*["']([^"']+)["']/gu,
    /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.startsWith("."))
        found.push(specifier);
    }
  }

  return found;
}

/**
 * The transitive, statically-imported module set for a document's scripts.
 *
 * A module the document names is never enough on its own: the entry chunks in
 * this build import a shared preload helper, and counting only the entry would
 * under-report what the browser actually downloads before the page is
 * interactive.
 */
async function moduleGraph(
  root: string,
  entries: readonly string[],
): Promise<{ resources: Resource[]; missing: string[] }> {
  const seen = new Map<string, Resource>();
  const missing: string[] = [];
  const queue: { relative: string; reason: string }[] = entries.map(
    (entry) => ({
      relative: toRelative(entry),
      reason: "named by the document",
    }),
  );

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (seen.has(next.relative)) continue;

    const resource = await resourceOf(root, next.relative, next.reason);
    if (resource === null) {
      missing.push(next.relative);
      continue;
    }

    seen.set(next.relative, resource);

    const source = await readFile(path.join(root, next.relative), "utf8");
    const directory = path.posix.dirname(next.relative);
    for (const specifier of importsIn(source)) {
      const resolved = path.posix.normalize(
        path.posix.join(directory, specifier),
      );
      queue.push({
        relative: resolved,
        reason: `imported by ${next.relative}`,
      });
    }
  }

  return { resources: [...seen.values()], missing };
}

/**
 * Font files referenced by `@font-face` rules in the given stylesheets.
 *
 * A `url()` in a stylesheet is only a font when it sits inside a `@font-face`
 * block; the same syntax is used for images elsewhere, and counting those as
 * web fonts would be wrong in both directions.
 */
async function fontsInStylesheets(
  root: string,
  stylesheets: readonly Resource[],
): Promise<Resource[]> {
  const fonts = new Map<string, Resource>();

  for (const sheet of stylesheets) {
    const css = await readFile(path.join(root, sheet.relative), "utf8");
    const directory = path.posix.dirname(sheet.relative);

    for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
      const body = block[1] ?? "";
      for (const url of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gu)) {
        const reference = url[1];
        if (reference === undefined || reference.startsWith("data:")) continue;
        const resolved = reference.startsWith("/")
          ? toRelative(reference)
          : path.posix.normalize(path.posix.join(directory, reference));
        const font = await resourceOf(
          root,
          resolved,
          `@font-face in ${sheet.relative}`,
        );
        if (font !== null) fonts.set(font.relative, font);
      }
    }
  }

  return [...fonts.values()];
}

async function measurePage(
  buildLabel: string,
  root: string,
  relative: string,
  url: string,
): Promise<PageMeasurement> {
  const html = await readFile(path.join(root, relative), "utf8");
  const links = collectLinks(html);
  const scripts = collectScriptSources(html);

  const entryPoints = [
    ...scripts,
    ...links
      .filter((link) => link.rel.includes("modulepreload"))
      .map((link) => link.href),
  ];

  const graph = await moduleGraph(root, entryPoints);
  if (graph.missing.length > 0) {
    throw new Error(
      `${buildLabel} ${relative} references ${graph.missing.length} script(s) that are not in the build: ${graph.missing.join(", ")}`,
    );
  }

  const stylesheets: Resource[] = [];
  for (const link of links.filter((item) => item.rel.includes("stylesheet"))) {
    const sheet = await resourceOf(root, toRelative(link.href), "stylesheet");
    if (sheet === null) {
      throw new Error(
        `${buildLabel} ${relative} references missing stylesheet ${link.href}`,
      );
    }
    stylesheets.push(sheet);
  }

  const fonts = await fontsInStylesheets(root, stylesheets);
  for (const link of links.filter(
    (item) => item.rel.includes("preload") && item.as === "font",
  )) {
    const font = await resourceOf(
      root,
      toRelative(link.href),
      "preloaded font",
    );
    if (font !== null) fonts.push(font);
  }

  const sum = (items: readonly Resource[]): number =>
    items.reduce((total, item) => total + item.gzipBytes, 0);

  return {
    build: buildLabel,
    url,
    file: relative,
    scripts: graph.resources,
    stylesheets,
    fonts,
    jsGzip: sum(graph.resources),
    cssGzip: sum(stylesheets),
    fontGzip: sum(fonts),
    hasDiagram: graph.resources.some((item) =>
      item.relative.includes("MermaidSupport"),
    ),
    hasFormula: stylesheets.some((item) => item.relative.includes("katex")),
    hasEmbed: hasIframe(html),
  };
}

/** Every page in a build, as `{ url, relative }`, sorted by URL. */
async function pagesOf(
  root: string,
  prefix = "",
): Promise<{ url: string; relative: string }[]> {
  const { readdir } = await import("node:fs/promises");
  const pages: { url: string; relative: string }[] = [];

  async function walk(
    directory: string,
    directoryRelative: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative =
        directoryRelative.length === 0
          ? entry.name
          : `${directoryRelative}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".html")) continue;

      const url =
        relative === "index.html"
          ? "/"
          : relative.endsWith("/index.html")
            ? `/${relative.slice(0, -"index.html".length)}`
            : `/${relative}`;

      if (prefix.length === 0 || url.startsWith(prefix))
        pages.push({ url, relative });
    }
  }

  await walk(root, "");
  return pages;
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main(): Promise<number> {
  const fixtureRoot = path.join(PROJECT_ROOT, "dist-fixtures");
  const emptyRoot = path.join(PROJECT_ROOT, "dist");

  for (const [dir, root] of [
    ["dist", emptyRoot],
    ["dist-fixtures", fixtureRoot],
  ] as const) {
    if (!existsSync(root)) {
      throw new Error(
        `${dir} does not exist. Build it first: ${dir === "dist" ? "pnpm build" : "pnpm build:fixtures"}.`,
      );
    }
  }

  // --- home pages ----------------------------------------------------------
  const homes: PageMeasurement[] = [
    await measurePage("dist", emptyRoot, "index.html", "/"),
    await measurePage("dist-fixtures", fixtureRoot, "index.html", "/"),
  ];

  // --- every article, so "ordinary" is chosen from real measurements --------
  const articles: PageMeasurement[] = [];
  for (const page of await pagesOf(fixtureRoot, "/posts/")) {
    articles.push(
      await measurePage("dist-fixtures", fixtureRoot, page.relative, page.url),
    );
  }

  const ordinary = articles.filter(
    (page) => !page.hasDiagram && !page.hasEmbed && !page.hasFormula,
  );
  if (ordinary.length === 0) {
    throw new Error(
      "No ordinary article was found in dist-fixtures: every article contains a diagram, an embed or a formula. The article budget cannot be measured.",
    );
  }

  const ordinaryWorst = ordinary.reduce((worst, page) =>
    page.jsGzip > worst.jsGzip ? page : worst,
  );
  const heaviest = [...homes, ...articles].reduce((worst, page) =>
    page.jsGzip > worst.jsGzip ? page : worst,
  );

  // --- budgets -------------------------------------------------------------
  const violations: BudgetViolation[] = [];

  if (ordinaryWorst.jsGzip > BUDGET.articleJsBytes) {
    violations.push({
      label: "ordinary article client JS",
      measured: ordinaryWorst.jsGzip,
      budget: BUDGET.articleJsBytes,
      detail: ordinaryWorst.url,
    });
  }

  for (const home of homes) {
    if (home.jsGzip > BUDGET.homeJsBytes) {
      violations.push({
        label: `home page client JS (${home.build})`,
        measured: home.jsGzip,
        budget: BUDGET.homeJsBytes,
        detail: home.url,
      });
    }
  }

  for (const page of [...homes, ...articles]) {
    if (page.cssGzip > BUDGET.cssBytes) {
      violations.push({
        label: `first-load CSS (${page.build} ${page.url})`,
        measured: page.cssGzip,
        budget: BUDGET.cssBytes,
        detail: page.stylesheets.map((sheet) => sheet.relative).join(", "),
      });
    }
  }

  for (const page of [...homes, ordinaryWorst]) {
    if (page.fontGzip > BUDGET.fontBytes) {
      violations.push({
        label: `web font bytes (${page.build} ${page.url})`,
        measured: page.fontGzip,
        budget: BUDGET.fontBytes,
        detail: page.fonts.map((font) => font.relative).join(", "),
      });
    }
  }

  const report = {
    generatedBy: "scripts/verify/performance.ts",
    budget: BUDGET,
    measured: {
      ordinaryArticle: {
        url: ordinaryWorst.url,
        jsGzip: ordinaryWorst.jsGzip,
        cssGzip: ordinaryWorst.cssGzip,
        fontGzip: ordinaryWorst.fontGzip,
        scripts: ordinaryWorst.scripts,
        stylesheets: ordinaryWorst.stylesheets,
      },
      ordinaryArticleCount: ordinary.length,
      articleCount: articles.length,
      homes: homes.map((home) => ({
        build: home.build,
        url: home.url,
        jsGzip: home.jsGzip,
        cssGzip: home.cssGzip,
        fontGzip: home.fontGzip,
        scripts: home.scripts,
        stylesheets: home.stylesheets,
      })),
      heaviestPage: {
        build: heaviest.build,
        url: heaviest.url,
        jsGzip: heaviest.jsGzip,
      },
      diagramArticles: articles
        .filter((page) => page.hasDiagram)
        .map((page) => ({ url: page.url, jsGzip: page.jsGzip })),
      formulaArticles: articles
        .filter((page) => page.hasFormula)
        .map((page) => ({
          url: page.url,
          cssGzip: page.cssGzip,
          fontGzip: page.fontGzip,
        })),
    },
    violations,
    passed: violations.length === 0,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`ordinary article (${ordinaryWorst.url})`);
  console.log(
    `  client JS   ${formatKb(ordinaryWorst.jsGzip)} gzip   budget 50.0 KB`,
  );
  console.log(
    `  CSS         ${formatKb(ordinaryWorst.cssGzip)} gzip   budget 40.0 KB`,
  );
  console.log(
    `  web fonts   ${formatKb(ordinaryWorst.fontGzip)} gzip   budget  0.0 KB`,
  );
  console.log(
    `  scripts:    ${ordinaryWorst.scripts.map((item) => item.relative).join(", ")}`,
  );

  for (const home of homes) {
    console.log(`home page (${home.build} ${home.url})`);
    console.log(
      `  client JS   ${formatKb(home.jsGzip)} gzip   budget 100.0 KB`,
    );
    console.log(
      `  CSS         ${formatKb(home.cssGzip)} gzip   budget  40.0 KB`,
    );
  }

  console.log(
    `\nmeasured ${articles.length} article(s): ${ordinary.length} ordinary, ${articles.filter((page) => page.hasDiagram).length} with a diagram, ${articles.filter((page) => page.hasFormula).length} with a formula`,
  );
  console.log(
    `heaviest first-load JS anywhere: ${heaviest.url} at ${formatKb(heaviest.jsGzip)}`,
  );
  console.log(`report written to ${path.relative(PROJECT_ROOT, REPORT_PATH)}`);

  if (violations.length === 0) {
    console.log("\nperformance: PASS — every resource budget is met.");
    return 0;
  }

  console.error(
    `\nperformance: FAIL — ${violations.length} budget(s) exceeded:`,
  );
  for (const violation of violations) {
    console.error(
      `  ${violation.label}: ${formatKb(violation.measured)} > ${formatKb(violation.budget)} (${violation.detail})`,
    );
  }
  return 1;
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

export { BUDGET, measurePage, moduleGraph, importsIn };
