import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { MEDIA_ORIGIN } from "../../src/lib/site.js";

/**
 * Checks and adjustments that can only run once the output directory exists.
 *
 * Two jobs, both of which are about not shipping something untrue:
 *
 * 1. **The fixture leak guard.** A normal build must contain no trace of the
 *    test content. The check is deliberately paranoid — it looks for the
 *    fixture marker, the fixture directory names and a sentinel string that
 *    exists nowhere else, across every emitted file including the search index.
 *    A passing build that contains the sentinel would mean the content source
 *    selection leaked, which is the one failure this project cannot tolerate.
 *
 * 2. **The preview noindex header.** A local or preview build is not the site
 *    and must not be indexed. The rule is appended to the *built* `_headers`,
 *    never to the version-controlled source, so `public/_headers` stays
 *    identical in every environment.
 */

export interface PostbuildOptions {
  readonly dir: string;
  readonly kind: "default" | "fixtures" | "pages";
  readonly log: (message: string) => void;
}

/**
 * A string that exists only inside the fixtures.
 *
 * If it appears in a normal build, test content reached production. Kept as a
 * constant here so the guard and the fixture cannot drift apart silently — the
 * guard fails loudly if the fixture stops carrying it.
 */
export const FIXTURE_SENTINEL = "ANI_NANO_FIXTURE_SENTINEL_7f3a9c1e";

/** A valid, deliberately non-resolving origin used only in the source template. */
export const MEDIA_ORIGIN_TEMPLATE = "https://media.example.invalid";

/** Substrings that must never appear in a normal build. */
const FORBIDDEN_MARKERS: readonly string[] = [
  FIXTURE_SENTINEL,
  "TEST FIXTURE",
  "data-test-fixture",
  "tests/fixtures",
  "tests\\fixtures",
];

/** Files the build must always produce. */
const REQUIRED_FILES: readonly string[] = [
  "index.html",
  "404.html",
  "robots.txt",
  "sitemap-index.xml",
  "_headers",
  "favicon.svg",
];

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  if (existsSync(root)) await walk(root);
  return found;
}

/** Only text-like files are searched; binaries are scanned as UTF-8 anyway. */
async function readText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (info.size > 8 * 1024 * 1024) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export interface LeakReport {
  readonly filesScanned: number;
  readonly leaks: readonly { file: string; marker: string }[];
  readonly sentinelPresent: boolean;
}

/**
 * Scan an output directory for traces of fixture content.
 */
export async function scanForLeaks(root: string): Promise<LeakReport> {
  const files = await listFiles(root);
  const leaks: { file: string; marker: string }[] = [];
  let sentinelPresent = false;

  for (const file of files) {
    const text = await readText(file);
    if (text === null) continue;

    if (text.includes(FIXTURE_SENTINEL)) sentinelPresent = true;

    for (const marker of FORBIDDEN_MARKERS) {
      // The fixture build legitimately contains all of these.
      if (marker === FIXTURE_SENTINEL) continue;
      if (text.includes(marker)) {
        leaks.push({ file: path.relative(root, file), marker });
      }
    }
  }

  return { filesScanned: files.length, leaks, sentinelPresent };
}

/**
 * Bind the configured public media origin into the emitted Cloudflare policy.
 *
 * The source file intentionally contains a non-resolving template origin. A
 * build must replace both CSP occurrences, which makes configuration drift a
 * hard failure instead of silently shipping a policy that blocks every image.
 */
export function bindMediaOrigin(source: string, mediaOrigin: string): string {
  const occurrences = source.split(MEDIA_ORIGIN_TEMPLATE).length - 1;
  if (occurrences !== 2) {
    throw new Error(
      `postbuild: expected exactly two ${MEDIA_ORIGIN_TEMPLATE} placeholders in _headers, found ${occurrences}.`,
    );
  }
  return source.replaceAll(MEDIA_ORIGIN_TEMPLATE, mediaOrigin);
}

export async function postbuild(options: PostbuildOptions): Promise<void> {
  const { dir, kind, log } = options;
  const root = path.resolve(PROJECT_ROOT, dir);

  if (!existsSync(root)) {
    throw new Error(`postbuild: ${root} does not exist.`);
  }

  // --- required artefacts --------------------------------------------------
  const missing = REQUIRED_FILES.filter(
    (file) => !existsSync(path.join(root, file)),
  );
  if (missing.length > 0) {
    throw new Error(`postbuild: the build is missing ${missing.join(", ")}.`);
  }

  // --- fixture leak guard --------------------------------------------------
  if (kind === "fixtures") {
    // A fixture build is *expected* to contain the marker, so the guard checks
    // the opposite thing: that the sentinel really is being planted, otherwise
    // the normal-build check below would pass vacuously.
    const report = await scanForLeaks(root);
    if (!report.sentinelPresent) {
      throw new Error(
        `postbuild: the fixture build does not contain ${FIXTURE_SENTINEL}. The leak guard would pass vacuously, so the fixture must carry it.`,
      );
    }
    log(
      `fixture build verified: sentinel present across ${report.filesScanned} file(s)`,
    );
  } else {
    const report = await scanForLeaks(root);
    if (report.sentinelPresent) {
      throw new Error(
        `postbuild: fixture content leaked into ${dir} — ${FIXTURE_SENTINEL} was found.`,
      );
    }
    if (report.leaks.length > 0) {
      const detail = report.leaks
        .slice(0, 10)
        .map((leak) => `  ${leak.file} contains ${JSON.stringify(leak.marker)}`)
        .join("\n");
      throw new Error(`postbuild: fixture traces found in ${dir}:\n${detail}`);
    }
    log(
      `leak guard passed: ${report.filesScanned} file(s) scanned, no fixture traces`,
    );
  }

  // --- preview noindex -----------------------------------------------------
  const siteEnv = process.env["SITE_ENV"] ?? "local";
  const headersPath = path.join(root, "_headers");

  if (
    (siteEnv === "production" || siteEnv === "preview") &&
    !MEDIA_ORIGIN.startsWith("https://")
  ) {
    throw new Error(
      `postbuild: PUBLIC_MEDIA_ORIGIN must use https for SITE_ENV=${siteEnv}, but received ${JSON.stringify(MEDIA_ORIGIN)}.`,
    );
  }

  const sourceHeaders = await readFile(headersPath, "utf8");
  await writeFile(
    headersPath,
    bindMediaOrigin(sourceHeaders, MEDIA_ORIGIN),
    "utf8",
  );
  log(`CSP media origin bound to ${MEDIA_ORIGIN}`);

  if (siteEnv !== "production") {
    // Appended to the emitted file only. `public/_headers` is never rewritten,
    // so the tracked source stays identical everywhere.
    await appendFile(
      headersPath,
      "\n# Added by postbuild for a non-production environment.\n/*\n  X-Robots-Tag: noindex, nofollow\n",
      "utf8",
    );
    log(`noindex header added for SITE_ENV=${siteEnv}`);
  }

  // --- search index --------------------------------------------------------
  if (!existsSync(path.join(root, "_pagefind"))) {
    throw new Error("postbuild: the search index is missing.");
  }

  // --- self-hosted KaTeX ---------------------------------------------------
  await copyKatex(root, log);
}

/**
 * Copy KaTeX's stylesheet and fonts into the build's own asset directory.
 *
 * KaTeX's CSS and fonts must be self-hosted and
 * requested only by pages that contain a formula. Importing the package's CSS
 * through Astro would put it in the shared stylesheet for every page, so the
 * files are copied to `/assets/katex/` instead and only the article layout
 * emits the `<link>`, and only when the article has a formula.
 *
 * `/assets/*` is already `immutable` in the header policy, so the fonts are
 * cached for a year without adding a rule.
 */
async function copyKatex(
  root: string,
  log: (message: string) => void,
): Promise<void> {
  const source = path.join(PROJECT_ROOT, "node_modules", "katex", "dist");
  if (!existsSync(source)) {
    throw new Error(
      "postbuild: the katex package is not installed, so formulas cannot be styled.",
    );
  }

  const target = path.join(root, "assets", "katex");
  await mkdir(target, { recursive: true });
  await cp(
    path.join(source, "katex.min.css"),
    path.join(target, "katex.min.css"),
  );
  // The stylesheet references its fonts relatively, so they must sit beside it.
  await cp(path.join(source, "fonts"), path.join(target, "fonts"), {
    recursive: true,
  });

  log(`katex assets copied to ${path.relative(PROJECT_ROOT, target)}`);
}
