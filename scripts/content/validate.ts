import path from "node:path";

import {
  isPublicAt,
  type VisibilityFields,
} from "../../src/lib/content/visibility.js";
import { parseContentPath } from "../../src/lib/content/paths.js";
import { findCaseInsensitiveCollision } from "../lib/safe-paths.js";
import type { ManifestMedia } from "../release/manifest.js";
import { extractDocument, type ExtractedDocument } from "./extract.js";
import type { ContentEntry, ContentIssue, ContentSource } from "./load.js";
import { checkRedirects } from "./redirects.js";

/**
 * The validation gate every release passes through.
 *
 * It answers one question — may this become a release? — and it answers it by
 * collecting every problem rather than stopping at the first, because an author
 * fixing one error at a time is an author who runs this command a dozen times.
 *
 * Three classes of check live here:
 *
 * - **Single file**: frontmatter the schema accepted, a body a reader can
 *   actually read, no H1 (the title is the only H1), well-formed code fences,
 *   callout types that exist, MDX that stays inside the whitelist.
 * - **Across files**: one URL per file, no two paths that collide on a
 *   case-insensitive filesystem, consistent tag labels, consistent series
 *   titles, unique series ordering, and no page that shadows a system route.
 * - **References**: internal links and `/media/…` images must resolve to
 *   something that will exist at build time.
 */

/** Routes the site itself owns. Content may not shadow any of them. */
export const SYSTEM_ROUTES: readonly string[] = [
  "/",
  "/posts/",
  "/archive/",
  "/tags/",
  "/series/",
  "/search/",
  "/rss.xml",
  "/robots.txt",
  "/404.html",
];

/** Prefixes the site owns; a page under one of them is a conflict. */
const SYSTEM_PREFIXES: readonly string[] = [
  "/page/",
  "/archive/page/",
  "/tags/",
  "/series/",
  "/posts/",
  "/assets/",
  "/og/",
  "/_pagefind/",
];

/** Static files a link may legitimately point at. */
const STATIC_FILES: readonly string[] = [
  "/rss.xml",
  "/robots.txt",
  "/404.html",
  "/favicon.svg",
];

export interface ValidateOptions {
  readonly source: ContentSource;
  readonly now: Date;
  /**
   * True when validating for publication: public entries are checked as they
   * will be rendered, and media must be resolvable.
   */
  readonly publication: boolean;
  /** Require every cover and body image to have a local media record. */
  readonly strictMedia: boolean;
  /** Media records that live outside the workspace (e.g. fetched from R2). */
  readonly extraMedia?: ReadonlyMap<
    string,
    { readonly files: readonly string[] }
  >;
}

export interface ValidationReport {
  readonly issues: readonly ContentIssue[];
  readonly errors: number;
  readonly warnings: number;
  readonly entryCount: number;
  readonly publicPosts: number;
  readonly publicPages: number;
  readonly documents: ReadonlyMap<string, ExtractedDocument>;
}

/**
 * Routes the site serves regardless of content.
 *
 * The redirect table is checked against these plus every content URL, because a
 * redirect may legitimately point at `/about/`, `/archive/` or another
 * generated index just as easily as at a specific article.
 */
export const ALWAYS_PRESENT_URLS: readonly string[] = [
  "/",
  "/posts/",
  "/archive/",
  "/tags/",
  "/series/",
  "/search/",
  "/about/",
  "/404.html",
];

interface MutableReport {
  issues: ContentIssue[];
  documents: Map<string, ExtractedDocument>;
}

/**
 * The fields the one visibility rule reads, derived from raw frontmatter in
 * exactly one place.
 *
 * Four copies of this object literal used to live in this file, which is four
 * chances for one of them to decide that an unparsable date, or a `draft`
 * written as the string `"true"`, means something different from the other
 * three. Frontmatter is raw here: it may be missing, or the wrong type, because
 * the schema that would have rejected it has already been recorded as an error.
 */
function visibilityFieldsOf(entry: ContentEntry): VisibilityFields {
  return {
    draft: entry.data["draft"] === true,
    publishedAt:
      typeof entry.data["publishedAt"] === "string"
        ? entry.data["publishedAt"]
        : undefined,
  };
}

/**
 * Whether an entry must be complete: a readable body, no body H1, and media
 * that resolves.
 *
 * This is decided by `draft` alone, never by visibility. `draft: false` with a
 * future `publishedAt` is an article the next build publishes — the only reason
 * it is not on the site today is the clock — so validating it leniently let
 * `content:publish` accept an empty body and a dangling cover and report zero
 * errors. An entry whose date cannot be parsed is strict too: "we could not
 * tell whether this is public" must not be the answer that skips the checks.
 */
function isStrictEntry(entry: ContentEntry): boolean {
  return entry.data["draft"] !== true;
}

function add(
  report: MutableReport,
  severity: "error" | "warning",
  code: string,
  message: string,
  file?: string,
  field?: string,
): void {
  report.issues.push({
    severity,
    code,
    message,
    ...(file === undefined ? {} : { file }),
    ...(field === undefined ? {} : { field }),
  });
}

const EXPLICIT_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function checkRawDates(entry: ContentEntry, report: MutableReport): void {
  for (const field of ["publishedAt", "updatedAt"] as const) {
    const raw = entry.data[field];
    if (raw === undefined) continue;

    if (typeof raw !== "string") {
      add(
        report,
        "error",
        "date",
        `${field} was parsed as ${raw instanceof Date ? "an unquoted YAML timestamp" : typeof raw}; write it as a quoted ISO 8601 datetime with an explicit offset, e.g. "2026-09-15T09:00:00+08:00".`,
        entry.relativePath,
        field,
      );
      continue;
    }

    if (!EXPLICIT_OFFSET.test(raw)) {
      add(
        report,
        "error",
        "date",
        `${field} must be a full ISO 8601 datetime with an explicit UTC offset (for example 2026-09-15T09:00:00+08:00), but is ${JSON.stringify(raw)}.`,
        entry.relativePath,
        field,
      );
    }
  }
}

function normalizeTarget(url: string): string {
  const withoutHash = url.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  return withoutQuery;
}

function isExternal(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(url);
}

function checkLinks(
  entry: ContentEntry,
  document: ExtractedDocument,
  report: MutableReport,
  context: {
    readonly urls: ReadonlySet<string>;
    readonly files: ReadonlySet<string>;
    readonly headings: ReadonlyMap<string, ReadonlySet<string>>;
    readonly mediaPaths: ReadonlySet<string>;
  },
): void {
  for (const link of document.links) {
    const target = normalizeTarget(link.url);
    const where = `${entry.relativePath}:${link.line ?? "?"}`;

    if (link.url.startsWith("//")) {
      add(
        report,
        "error",
        "link",
        `${where}: protocol-relative URLs are not allowed; use https:.`,
        entry.relativePath,
      );
      continue;
    }

    if (isExternal(link.url)) {
      if (!link.url.startsWith("https:")) {
        add(
          report,
          "error",
          "link",
          `${where}: only https: links are allowed, but this link uses ${link.url.split(":")[0] ?? "?"}:.`,
          entry.relativePath,
        );
      }
      continue;
    }

    if (target.length === 0) {
      // A pure fragment: it must name a heading in this document.
      const fragment = link.url.slice(1);
      if (
        fragment.length > 0 &&
        !document.headings.some((heading) => heading.slug === fragment)
      ) {
        add(
          report,
          "error",
          "link",
          `${where}: no heading in this file has the anchor #${fragment}.`,
          entry.relativePath,
        );
      }
      continue;
    }

    if (target.startsWith("/media/")) {
      if (!context.mediaPaths.has(target)) {
        add(
          report,
          "error",
          "media",
          `${where}: ${target} is not a media object recorded for this release.`,
          entry.relativePath,
        );
      }
      continue;
    }

    if (target.startsWith("/")) {
      if (context.urls.has(target) || STATIC_FILES.includes(target)) continue;
      add(
        report,
        "error",
        "link",
        `${where}: ${target} does not resolve to a page that will exist.`,
        entry.relativePath,
      );
      continue;
    }

    // A relative link: resolve it against this file's directory.
    const directory = path.posix.dirname(entry.relativePath);
    const resolved = path.posix.normalize(path.posix.join(directory, target));
    const candidates = [
      resolved,
      `${resolved}.md`,
      `${resolved}.mdx`,
      path.posix.join(resolved, "_index.md"),
    ];

    const match = candidates.find((candidate) => context.files.has(candidate));
    if (match === undefined) {
      add(
        report,
        "error",
        "link",
        `${where}: relative link ${link.url} does not name a content file in this release.`,
        entry.relativePath,
      );
      continue;
    }

    const fragment = link.url.includes("#")
      ? (link.url.split("#")[1] ?? "")
      : "";
    if (fragment.length > 0) {
      const headings = context.headings.get(match);
      if (headings !== undefined && !headings.has(fragment)) {
        add(
          report,
          "error",
          "link",
          `${where}: ${match} has no heading with the anchor #${fragment}.`,
          entry.relativePath,
        );
      }
    }
  }
}

function checkMediaReferences(
  entry: ContentEntry,
  document: ExtractedDocument,
  report: MutableReport,
  options: ValidateOptions,
  referenced: Set<string>,
): void {
  const cover = entry.data["cover"];
  const references: string[] = [];

  // A document that is going to be published needs its media verified, whether
  // or not the clock has reached its publication instant. A draft may reference
  // media that has not been imported yet — it is not going to be rendered — so
  // that is a warning rather than a wall.
  const missingSeverity: "error" | "warning" =
    options.strictMedia && isStrictEntry(entry) ? "error" : "warning";

  if (typeof cover === "object" && cover !== null) {
    const src = (cover as { src?: unknown }).src;
    if (typeof src === "string") references.push(src);
  }
  for (const image of document.media) references.push(image.path);

  for (const reference of references) {
    const match = /^\/media\/([0-9a-f]{64})\/(.+)$/u.exec(reference);
    if (match === null) {
      add(
        report,
        "error",
        "media",
        `${entry.relativePath}: ${reference} is not a content-addressed media path; import the file with media:add first.`,
        entry.relativePath,
      );
      continue;
    }

    const digest = match[1] ?? "";
    const fileName = match[2] ?? "";
    referenced.add(reference);

    const record = options.source.mediaRecords.get(digest);
    const extra = options.extraMedia?.get(digest);

    if (record === undefined && extra === undefined) {
      add(
        report,
        missingSeverity,
        "media-missing",
        `${entry.relativePath}: no local media record for /media/${digest}/. Run media:add on the source file, or make the file available before publishing.`,
        entry.relativePath,
      );
      continue;
    }

    const known =
      record === undefined
        ? (extra?.files ?? []).map((file) => `/media/${digest}/${file}`)
        : [
            record.original.path,
            ...record.variants.map((variant) => variant.path),
          ];

    if (!known.includes(reference)) {
      add(
        report,
        "error",
        "media",
        `${entry.relativePath}: /media/${digest}/${fileName} is not one of the derivatives recorded for that asset.`,
        entry.relativePath,
      );
    }

    if (
      record !== undefined &&
      fileName === "1600.webp" &&
      reference === coverSrc(cover)
    ) {
      const cover1600 = record.variants.find(
        (variant) => variant.width === 1600 && variant.format === "webp",
      );
      if (cover1600 === undefined || cover1600.height !== 900) {
        add(
          report,
          "error",
          "media",
          `${entry.relativePath}: the cover variant for /media/${digest}/ is not 1600×900.`,
          entry.relativePath,
        );
      }
    }
  }
}

function coverSrc(cover: unknown): string | null {
  if (typeof cover !== "object" || cover === null) return null;
  const src = (cover as { src?: unknown }).src;
  return typeof src === "string" ? src : null;
}

export function validateSource(options: ValidateOptions): ValidationReport {
  const report: MutableReport = { issues: [], documents: new Map() };
  const { source } = options;

  // Issues the loader found — an unparseable frontmatter block, a path that
  // cannot produce a URL, a field the schema rejected — are part of the report
  // too. Dropping them here would make `content:validate` pass on a file that
  // `content:publish` refuses.
  for (const issue of source.issues) report.issues.push(issue);

  const urls = new Map<string, string>();
  const files = new Map<string, ContentEntry>();
  const headings = new Map<string, ReadonlySet<string>>();
  const mediaPaths = new Set<string>();

  // --- per document --------------------------------------------------------

  for (const entry of source.entries) {
    files.set(entry.relativePath, entry);

    const document = extractDocument(entry.body, {
      file: entry.relativePath,
      mdx: entry.relativePath.endsWith(".mdx"),
    });
    report.documents.set(entry.relativePath, document);

    for (const problem of document.problems) {
      add(report, "error", "markdown", problem, entry.relativePath);
    }

    checkRawDates(entry, report);

    /*
     * The anchors this document actually publishes.
     *
     * `ExtractedDocument.headings` carries the id the renderer would emit,
     * de-duplication included, so a cross-file link to `#a-2` resolves when the
     * second `## A` really is `a-2`. The ids are unique by construction, which
     * is why this is a set and not a count.
     */
    const anchors = new Set<string>();
    for (const heading of document.headings) anchors.add(heading.slug);
    headings.set(entry.relativePath, anchors);

    const draft = entry.data["draft"] === true;

    if (entry.collection !== "postIndexes") {
      if (isStrictEntry(entry)) {
        if (document.h1Lines.length > 0) {
          add(
            report,
            "error",
            "body-h1",
            `${entry.relativePath}: the body contains an H1 on line ${document.h1Lines[0] ?? 0}; the title is the only H1.`,
            entry.relativePath,
          );
        }
        if (!document.hasVisibleContent) {
          add(
            report,
            "error",
            "body-empty",
            `${entry.relativePath}: a document that will be published needs a body; this one has no visible content.`,
            entry.relativePath,
          );
        }
      } else if (!document.hasVisibleContent) {
        add(
          report,
          "warning",
          "body-empty-draft",
          `${entry.relativePath}: this draft has no body yet.`,
          entry.relativePath,
        );
      }
    } else if (draft) {
      add(
        report,
        "warning",
        "index-draft",
        `${entry.relativePath}: this directory index is a draft, so its title and prose are ignored while its directory page is still generated.`,
        entry.relativePath,
      );
    }
  }

  // --- routes --------------------------------------------------------------

  for (const entry of source.entries) {
    if (entry.url.length === 0) continue;
    const existing = urls.get(entry.url);
    if (existing !== undefined) {
      add(
        report,
        "error",
        "route-collision",
        `${entry.relativePath} and ${existing} both produce the URL ${entry.url}.`,
        entry.relativePath,
      );
      continue;
    }
    urls.set(entry.url, entry.relativePath);
  }

  const pathCollision = findCaseInsensitiveCollision(
    source.entries.map((entry) => entry.relativePath),
  );
  if (pathCollision !== undefined) {
    add(
      report,
      "error",
      "case-collision",
      `${pathCollision.a} and ${pathCollision.b} differ only by case, which collides on Windows and macOS.`,
      pathCollision.a,
    );
  }

  const urlCollision = findCaseInsensitiveCollision([...urls.keys()]);
  if (urlCollision !== undefined) {
    add(
      report,
      "error",
      "case-collision",
      `The URLs ${urlCollision.a} and ${urlCollision.b} differ only by case.`,
    );
  }

  for (const entry of source.entries) {
    if (entry.collection !== "pages" || entry.url.length === 0) continue;
    if (entry.url === "/about/") continue;

    if (SYSTEM_ROUTES.includes(entry.url)) {
      add(
        report,
        "error",
        "reserved-route",
        `${entry.relativePath} produces ${entry.url}, which is a route the site reserves.`,
        entry.relativePath,
      );
      continue;
    }
    const prefix = SYSTEM_PREFIXES.find((candidate) =>
      entry.url.startsWith(candidate),
    );
    if (prefix !== undefined) {
      add(
        report,
        "error",
        "reserved-route",
        `${entry.relativePath} produces ${entry.url}, which shadows the reserved ${prefix} space.`,
        entry.relativePath,
      );
    }
  }

  /*
   * Path validation.
   *
   * The loader checks every file it reads and reports a precise message for
   * each one, so this loop is the check for a source assembled some other way.
   * It used to call `parseContentPath` inside a `try` whose `catch` discarded
   * the exception, which read like a check and was not one: an entry whose path
   * cannot produce a URL reached the route tables unchallenged.
   */
  for (const entry of source.entries) {
    try {
      parseContentPath(entry.relativePath);
    } catch (error) {
      const alreadyReported = source.issues.some(
        (issue) => issue.file === entry.relativePath && issue.code === "path",
      );
      if (alreadyReported) continue;

      add(
        report,
        "error",
        "path",
        error instanceof Error ? error.message : String(error),
        entry.relativePath,
      );
    }
  }

  // --- tags and series -----------------------------------------------------

  const tagLabels = new Map<string, string>();
  const seriesTitles = new Map<string, string>();
  const seriesOrders = new Map<string, Map<number, string>>();

  for (const entry of source.entries) {
    const tags = entry.data["tags"];
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (typeof tag !== "object" || tag === null) continue;
        const id = (tag as { id?: unknown }).id;
        const label = (tag as { label?: unknown }).label;
        if (typeof id !== "string" || typeof label !== "string") continue;
        const existing = tagLabels.get(id);
        if (existing === undefined) {
          tagLabels.set(id, label);
        } else if (existing !== label) {
          add(
            report,
            "error",
            "tag-label",
            `${entry.relativePath}: tag "${id}" is labelled "${label}" here and "${existing}" elsewhere; one id must have one label across the release.`,
            entry.relativePath,
            "tags",
          );
        }
      }
    }

    const series = entry.data["series"];
    if (typeof series === "object" && series !== null) {
      const id = (series as { id?: unknown }).id;
      const title = (series as { title?: unknown }).title;
      const order = (series as { order?: unknown }).order;
      if (typeof id !== "string") continue;

      if (typeof title === "string") {
        const existing = seriesTitles.get(id);
        if (existing === undefined) {
          seriesTitles.set(id, title);
        } else if (existing !== title) {
          add(
            report,
            "error",
            "series-title",
            `${entry.relativePath}: series "${id}" is titled "${title}" here and "${existing}" elsewhere.`,
            entry.relativePath,
            "series",
          );
        }
      }

      if (typeof order === "number") {
        let orders = seriesOrders.get(id);
        if (orders === undefined) {
          orders = new Map();
          seriesOrders.set(id, orders);
        }
        const previous = orders.get(order);
        if (previous !== undefined) {
          add(
            report,
            "error",
            "series-order",
            `${entry.relativePath} and ${previous} both use series order ${order} in "${id}".`,
            entry.relativePath,
            "series",
          );
        } else {
          orders.set(order, entry.relativePath);
        }
      }
    }
  }

  // --- references ----------------------------------------------------------

  const allUrls = new Set<string>(urls.keys());
  const fileSet = new Set<string>(files.keys());

  // Media first, so a link anywhere in the release can resolve against media
  // declared by any file.
  for (const entry of source.entries) {
    const document = report.documents.get(entry.relativePath);
    if (document === undefined) continue;
    checkMediaReferences(entry, document, report, options, mediaPaths);
  }

  // The site's own routes are link targets too. Without them a perfectly good
  // link to `/posts/` or `/archive/` was reported as pointing at nothing,
  // because those URLs come from `src/pages/` rather than from a content file
  // and so never appear in `urls`.
  for (const url of ALWAYS_PRESENT_URLS) allUrls.add(url);

  for (const entry of source.entries) {
    const document = report.documents.get(entry.relativePath);
    if (document === undefined) continue;
    checkLinks(entry, document, report, {
      urls: allUrls,
      files: fileSet,
      headings,
      mediaPaths,
    });
  }

  // --- media records -------------------------------------------------------

  if (options.strictMedia && options.publication) {
    for (const entry of source.entries) {
      // Strictness is `draft`'s decision, as everywhere else in this file: a
      // cover whose bytes nobody can verify is a broken article whether or not
      // its publication instant has arrived.
      if (!isStrictEntry(entry)) continue;

      const src = coverSrc(entry.data["cover"]);
      if (src === null) continue;
      const digest = /^\/media\/([0-9a-f]{64})\//u.exec(src)?.[1];
      if (digest === undefined) continue;
      if (
        source.mediaRecords.has(digest) ||
        options.extraMedia?.has(digest) === true
      )
        continue;

      add(
        report,
        "error",
        "media-missing",
        `${entry.relativePath}: the cover /media/${digest}/ has no media record, so its bytes cannot be verified.`,
        entry.relativePath,
        "cover",
      );
    }
  }

  report.issues.sort((a, b) => {
    const fileA = a.file ?? "";
    const fileB = b.file ?? "";
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    const fieldA = a.field ?? "";
    const fieldB = b.field ?? "";
    return fieldA < fieldB ? -1 : fieldA > fieldB ? 1 : 0;
  });

  // Published-entry counts, which are a visibility question rather than a
  // strictness one, so they are the one place `isPublicAt` is still asked.
  let publicPosts = 0;
  let publicPages = 0;
  for (const entry of source.entries) {
    if (!isPublicAt(visibilityFieldsOf(entry), options.now)) continue;
    if (entry.collection === "posts") publicPosts += 1;
    if (entry.collection === "pages") publicPages += 1;
  }

  return {
    issues: report.issues,
    errors: report.issues.filter((issue) => issue.severity === "error").length,
    warnings: report.issues.filter((issue) => issue.severity === "warning")
      .length,
    entryCount: source.entries.length,
    publicPosts,
    publicPages,
    documents: report.documents,
  };
}

/**
 * Check the redirect table against the URLs a release will actually serve.
 *
 * Split from `validateSource` because it reads a second file — the checked-in
 * `public/_redirects` — and so cannot be part of a function whose only input is
 * one content source. Callers that have already built a report pass its URLs in
 * and merge the result; the redirect rules themselves are validated identically
 * whatever the content source is.
 */
export async function checkRedirectTable(
  source: ContentSource,
): Promise<readonly ContentIssue[]> {
  const known = new Set<string>(ALWAYS_PRESENT_URLS);
  for (const entry of source.entries) {
    if (entry.url.length > 0) known.add(entry.url);
  }
  return checkRedirects(known, STATIC_FILES);
}

/**
 * Every media object the release references, in the shape the manifest wants.
 *
 * Collected from covers and from `/media/…` images in bodies, so a release
 * declares the media it needs and `content:cleanup` can protect exactly that
 * set.
 */
export function collectMediaReferences(source: ContentSource): ManifestMedia[] {
  const paths = new Set<string>();

  for (const entry of source.entries) {
    const src = coverSrc(entry.data["cover"]);
    if (src !== null) paths.add(src);

    const document = extractDocument(entry.body, {
      file: entry.relativePath,
      mdx: entry.relativePath.endsWith(".mdx"),
    });
    for (const image of document.media) {
      if (image.path.startsWith("/media/")) paths.add(image.path);
    }
  }

  return [...paths]
    .sort()
    .map((mediaPath) => {
      const digest = /^\/media\/([0-9a-f]{64})\//u.exec(mediaPath)?.[1] ?? "";
      return { path: mediaPath, sha256: digest };
    })
    .filter((entry) => entry.sha256.length === 64);
}
