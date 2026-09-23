import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import { SITE_URL } from "../../src/lib/site.js";

/**
 * Internal link and anchor verification.
 *
 * Runs over *both* built output directories — `dist` (the empty build, which
 * the normal `pnpm build` produces) and `dist-fixtures` (the full content
 * build) — because a link that only exists when there is content is exactly
 * the kind of thing that ships broken.
 *
 * Three kinds of failure are reported:
 *
 * 1. **A missing target.** The `href` or `src` resolves to nothing in that
 *    build. Astro emits a directory per page (`/posts/x/` →
 *    `posts/x/index.html`), so a directory URL is resolved through
 *    `index.html`; anything else must exist as a file at its own path.
 * 2. **A dangling fragment.** `href="/posts/x/#heading"` points at a page that
 *    has no element with that `id`. A fragment never fails a build, so a
 *    renamed heading silently breaks every link to it.
 * 3. **A same-origin absolute URL that no longer exists.** The canonical link
 *    is written with the site origin; it is an internal link that happens to
 *    be spelled out.
 *
 * External URLs are skipped: this script is offline by design and cannot know
 * whether `https://creativecommons.org/...` is up. The media bucket is
 * external in the same way — `media.example.invalid` is a Cloudflare resource this
 * repository is forbidden from creating, so its files are checked by the media
 * pipeline, not here.
 */

/** The builds that must both be clean. */
const BUILDS: readonly { readonly label: string; readonly dir: string }[] = [
  { label: "dist", dir: "dist" },
  { label: "dist-fixtures", dir: "dist-fixtures" },
];

/** URL schemes that are never files in the build. */
const EXTERNAL_SCHEMES = [
  "mailto:",
  "tel:",
  "sms:",
  "javascript:",
  "data:",
  "blob:",
  "about:",
];

interface BrokenLink {
  readonly build: string;
  readonly source: string;
  readonly attribute: string;
  readonly value: string;
  readonly reason: string;
}

interface Document {
  /** URL path this document is served at, e.g. `/posts/x/`. */
  readonly url: string;
  /** Path relative to the build root, e.g. `posts/x/index.html`. */
  readonly relative: string;
  readonly ids: ReadonlySet<string>;
}

interface BuildIndex {
  readonly label: string;
  readonly dir: string;
  /** Every file in the build, keyed by the URL path that serves it. */
  readonly files: ReadonlyMap<string, string>;
  readonly documents: readonly Document[];
  readonly references: number;
  readonly broken: readonly BrokenLink[];
}

type Resolution =
  | { readonly kind: "external" }
  | {
      readonly kind: "internal";
      readonly url: string;
      readonly fragment: string;
    };

/** Every regular file under `root`, as POSIX-relative paths, sorted. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  }

  await walk(root, "");
  return found;
}

/**
 * The URL path a build file is served at.
 *
 * Astro's `trailingSlash: 'always'` with `build.format: 'directory'` makes
 * every page a directory containing `index.html`, so `posts/x/index.html` is
 * served at `/posts/x/`. A file that is not an `index.html` — `rss.xml`,
 * `favicon.svg`, `404.html`, `assets/*`, `_pagefind/*` — is served at its own
 * path.
 */
function urlPathForFile(relative: string): string {
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) {
    return `/${relative.slice(0, -"index.html".length)}`;
  }
  return `/${relative}`;
}

/** Element ids in a document, so a fragment can be checked against them. */
function collectIds(html: string): Set<string> {
  const ids = new Set<string>();
  visit(fromHtml(html, { fragment: true }), "element", (node) => {
    const id = node.properties["id"];
    if (typeof id === "string" && id.length > 0) ids.add(id);
  });
  return ids;
}

interface Reference {
  readonly attribute: string;
  readonly value: string;
}

/**
 * Every `href`, `src` and `srcset` candidate in a document.
 *
 * `srcset` is included because a responsive image is the same kind of
 * reference as `src` and would otherwise go unchecked; every candidate in this
 * build is external, so the check is a no-op today and stays correct if a
 * self-hosted image is added later.
 */
function collectReferences(html: string): Reference[] {
  const references: Reference[] = [];

  const add = (attribute: string, value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      references.push({ attribute, value: value.trim() });
      return;
    }
    // hast expands a comma-separated `srcset` into an array of candidates.
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          references.push({ attribute, value: candidate.trim() });
        }
      }
    }
  };

  visit(fromHtml(html, { fragment: true }), "element", (node) => {
    add("href", node.properties["href"]);
    add("src", node.properties["src"]);
    add("srcset", node.properties["srcSet"]);
  });

  return references;
}

/**
 * Reduce a raw attribute value to either "external, skip" or a URL path plus
 * an optional fragment, resolved against the document it appeared in.
 */
function resolveReference(raw: string, fromUrl: string): Resolution {
  // A `srcset` candidate is "url descriptor"; only the URL matters here.
  const value = raw.split(/\s+/u)[0] ?? "";
  if (value.length === 0) return { kind: "external" };

  const lowered = value.toLowerCase();
  if (EXTERNAL_SCHEMES.some((scheme) => lowered.startsWith(scheme)))
    return { kind: "external" };
  // A text fragment (`#:~:text=`) is a browser instruction, not an element id.
  if (value.startsWith("#:~:")) return { kind: "external" };
  if (value.startsWith("//")) return { kind: "external" };

  if (value.startsWith("#") || value.startsWith("?")) {
    return { kind: "internal", url: fromUrl, fragment: fragmentOf(value) };
  }

  // A fully-qualified URL is internal only when it is this site.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { kind: "external" };
    }
    if (parsed.origin !== new URL(SITE_URL).origin) return { kind: "external" };
    return {
      kind: "internal",
      url: normalizeUrlPath(parsed.pathname),
      fragment: decodeFragment(parsed.hash),
    };
  }

  /*
   * The query string is dropped, because it is not part of the file's path.
   *
   * A cache-busting query is the normal way to spell "this URL changes when the
   * bytes change" — KaTeX's stylesheet carries `?v=<digest>` — and the file it
   * names is served from the path alone. Keeping the query made this checker look
   * for a file with a question mark in its name and report a link as broken when
   * the target was right there.
   */
  const queryIndex = value.indexOf("?");
  const withoutQuery = queryIndex === -1 ? value : value.slice(0, queryIndex);

  const hashIndex = withoutQuery.indexOf("#");
  const withoutFragment =
    hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex);
  const fragment =
    hashIndex === -1 ? "" : decodeFragment(withoutQuery.slice(hashIndex));

  if (withoutFragment.length === 0)
    return { kind: "internal", url: fromUrl, fragment };

  // A root-relative reference is already a URL path; only a document-relative
  // one has to be resolved against the current page's directory.
  if (withoutFragment.startsWith("/")) {
    return {
      kind: "internal",
      url: normalizeUrlPath(withoutFragment),
      fragment,
    };
  }

  // A relative reference resolves against the directory of the current page,
  // which for a directory URL is the URL itself.
  const lastSlash = fromUrl.lastIndexOf("/");
  const base = fromUrl.endsWith("/")
    ? fromUrl
    : fromUrl.slice(0, lastSlash + 1);
  const resolved = path.posix.normalize(path.posix.join(base, withoutFragment));

  return { kind: "internal", url: normalizeUrlPath(resolved), fragment };
}

function fragmentOf(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex === -1 ? "" : decodeFragment(value.slice(hashIndex));
}

function decodeFragment(hash: string): string {
  if (hash.length === 0 || hash === "#") return "";
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A URL path always starts with `/` and never repeats a separator. */
function normalizeUrlPath(value: string): string {
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/{2,}/gu, "/");
}

/**
 * Resolve a URL path to the file that serves it.
 *
 * `/posts/x/` is served by `posts/x/index.html`; `/rss.xml` is served by
 * `rss.xml`. A directory URL with no `index.html` is a broken link, not a
 * directory listing — there is no server here to synthesise one.
 */
function findFile(
  files: ReadonlyMap<string, string>,
  urlPath: string,
): string | undefined {
  const direct = files.get(urlPath);
  if (direct !== undefined) return direct;
  if (!urlPath.endsWith("/")) return files.get(`${urlPath}/`);
  return undefined;
}

async function indexBuild(label: string, dir: string): Promise<BuildIndex> {
  const root = path.join(PROJECT_ROOT, dir);
  if (!existsSync(root)) {
    throw new Error(
      `${dir} does not exist. Build it first: ${dir === "dist" ? "pnpm build" : "pnpm build:fixtures"}.`,
    );
  }

  const files = new Map<string, string>();
  for (const relative of await listFiles(root)) {
    files.set(urlPathForFile(relative), relative);
  }

  const documents: Document[] = [];
  const broken: BrokenLink[] = [];
  let references = 0;

  for (const [url, relative] of [...files.entries()].filter(([, file]) =>
    file.endsWith(".html"),
  )) {
    const html = await readFile(path.join(root, relative), "utf8");

    let ids: Set<string>;
    let found: Reference[];
    try {
      ids = collectIds(html);
      found = collectReferences(html);
    } catch (error) {
      broken.push({
        build: label,
        source: url,
        attribute: "-",
        value: relative,
        reason: `the document could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    documents.push({ url, relative, ids });
    references += found.length;

    for (const reference of found) {
      const resolution = resolveReference(reference.value, url);
      if (resolution.kind === "external") continue;

      const targetFile = findFile(files, resolution.url);
      if (targetFile === undefined) {
        broken.push({
          build: label,
          source: url,
          attribute: reference.attribute,
          value: reference.value,
          reason: `no file in ${dir} serves ${resolution.url}`,
        });
        continue;
      }

      if (resolution.fragment.length === 0 || !targetFile.endsWith(".html"))
        continue;

      const target = documents.find(
        (document) => document.url === resolution.url,
      );
      const targetIds =
        target?.ids ??
        collectIds(await readFile(path.join(root, targetFile), "utf8"));

      if (!targetIds.has(resolution.fragment)) {
        broken.push({
          build: label,
          source: url,
          attribute: reference.attribute,
          value: reference.value,
          reason: `${resolution.url} has no element with id ${JSON.stringify(resolution.fragment)}`,
        });
      }
    }
  }

  return { label, dir, files, documents, references, broken };
}

async function main(): Promise<number> {
  const indexes: BuildIndex[] = [];
  for (const build of BUILDS)
    indexes.push(await indexBuild(build.label, build.dir));

  const broken = indexes.flatMap((index) => index.broken);

  for (const index of indexes) {
    console.log(
      `${index.label}: ${index.documents.length} document(s), ${index.references} reference(s), ${index.files.size} file(s), ${index.broken.length} broken`,
    );
  }

  if (broken.length === 0) {
    console.log(
      "\nlinks: PASS — every internal href, src and fragment resolves.",
    );
    return 0;
  }

  console.error(`\nlinks: FAIL — ${broken.length} broken link(s):`);
  for (const link of broken) {
    console.error(
      `  [${link.build}] ${link.source} → ${link.attribute}="${link.value}"`,
    );
    console.error(`      ${link.reason}`);
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

export {
  collectIds,
  collectReferences,
  resolveReference,
  urlPathForFile,
  findFile,
};
