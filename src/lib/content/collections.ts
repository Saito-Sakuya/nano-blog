import { getCollection, type CollectionEntry } from "astro:content";

import { buildNow } from "./build-context.js";
import { readingTime } from "./reading-time.js";
import { isPublicAt } from "./visibility.js";
import {
  ROOT_INDEX_ID,
  ancestorDirectories,
  parseContentPath,
} from "./paths.js";
import {
  archivePageUrl,
  directoryPageUrl,
  directoryUrl,
  homePageUrl,
  pageUrl,
  postUrl,
  seriesPageUrl,
  seriesUrl,
  tagPageUrl,
  tagUrl,
} from "../routing/urls.js";
import { PAGE_SIZE, SITE_TIME_ZONE } from "../site.js";
import type {
  IndexFrontmatter,
  PageFrontmatter,
  PostFrontmatter,
} from "./schema.js";

/**
 * The read model the pages consume.
 *
 * Astro's own collection entries are close to the filesystem; these view models
 * are close to the page. Resolving the difference once, here, means a page never
 * has to remember the visibility rule, the reading-time formula or how a
 * directory title is derived — and means those rules exist in exactly one place.
 */

export interface PostView {
  readonly id: string;
  readonly url: string;
  readonly sourcePath: string;
  readonly segments: readonly string[];
  readonly data: PostFrontmatter;
  readonly body: string;
  readonly readingMinutes: number;
}

export interface PageView {
  readonly id: string;
  readonly url: string;
  readonly data: PageFrontmatter;
  readonly body: string;
}

export interface DirectoryView {
  readonly segments: readonly string[];
  readonly url: string;
  readonly title: string;
  readonly description: string;
  /**
   * Collection id of the public `_index.md` contributing this directory's
   * custom prose, or `null` when there is none. The route renders that entry so
   * the intro goes through the same Markdown pipeline as everything else
   * instead of being injected as raw HTML.
   */
  readonly indexEntryId: string | null;
  readonly order: number;
  readonly children: readonly DirectoryView[];
  /** Public posts anywhere in this subtree, newest first. */
  readonly posts: readonly PostView[];
  /** Public posts directly inside this directory, newest first. */
  readonly directPosts: readonly PostView[];
}

export interface TagView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly count: number;
}

export interface SeriesView {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly count: number;
  readonly posts: readonly PostView[];
  /** Newest `publishedAt` in the series. */
  readonly latest: string;
}

export interface ArchiveMonth {
  readonly month: string;
  readonly label: string;
  readonly posts: readonly PostView[];
}

export interface ArchiveYear {
  readonly year: string;
  readonly count: number;
  readonly months: readonly ArchiveMonth[];
}

export interface Site {
  readonly buildNow: Date;
  readonly posts: readonly PostView[];
  readonly tags: readonly TagView[];
  readonly series: readonly SeriesView[];
  readonly archive: readonly ArchiveYear[];
  readonly directories: ReadonlyMap<string, DirectoryView>;
  readonly root: DirectoryView;
  readonly pages: ReadonlyMap<string, PageView>;
  readonly about: PageView | null;
}

const DEFAULT_INDEX_DESCRIPTION = "浏览此目录下的公开文章与子目录。";

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Newest first; ties broken by canonical path so the order is total and stable
 * across machines.
 */
export function comparePosts(a: PostView, b: PostView): number {
  const byDate =
    Date.parse(b.data.publishedAt) - Date.parse(a.data.publishedAt);
  if (byDate !== 0) return byDate;
  return a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

type PostEntry = CollectionEntry<"posts">;
type IndexEntry = CollectionEntry<"postIndexes">;
type PageEntry = CollectionEntry<"pages">;

/**
 * The collection-relative source path of a post.
 *
 * Astro's own `filePath` is relative to the *project root*, so it begins with
 * `.ani-content/runtime/content/...` and its leading segments are
 * materialisation detail rather than content. Deriving URL segments from it
 * produced routes such as `/posts/.ani-content/runtime/content/posts/...`.
 *
 * The entry id is the authoritative path inside the collection: this project's
 * `generateId` built it from exactly that, so `dev/web/a` means `dev/web/a` in
 * every content mode.
 */
function postSourcePath(entry: PostEntry): string {
  const extension = (entry.filePath ?? "").endsWith(".mdx") ? ".mdx" : ".md";
  return `posts/${entry.id}${extension}`;
}

/** Collection-relative path of a directory index. */
function indexSourcePath(entry: IndexEntry): string {
  const directory = entry.id === ROOT_INDEX_ID ? "" : `${entry.id}/`;
  return `posts/${directory}_index.md`;
}

/** Directory segments a `_index.md` describes. */
function indexSegments(entry: IndexEntry): string[] {
  return entry.id === ROOT_INDEX_ID ? [] : entry.id.split("/");
}

/**
 * The collection-relative source path of a standalone page.
 *
 * `pages/about.md` and `pages/lab/notes.md` are what the author wrote; the entry
 * id is `about` and `lab/notes`. Rebuilding the canonical path from the id is
 * what lets the page route be checked against the same path rules the post
 * routes are checked against — without it, `pages/About.md` produced a route
 * `/About/` that went into the sitemap and the feed unchallenged.
 */
function pageSourcePath(entry: PageEntry): string {
  const extension = (entry.filePath ?? "").endsWith(".mdx") ? ".mdx" : ".md";
  return `pages/${entry.id}${extension}`;
}

/**
 * Directory segments of an entry, relative to the collection root.
 *
 * `entry.id` is already collection-relative (`dev/web/a`), whereas a canonical
 * content path carries the collection name as its first segment
 * (`posts/dev/web/a.md`). Reusing the canonical path's segments wholesale
 * produced routes like `/posts/posts/dev/...`, so the two are kept apart
 * deliberately: the canonical path is what gets *validated*, the id is what
 * gets *routed*.
 */
function idSegments(id: string): string[] {
  const parts = id.split("/");
  parts.pop();
  return parts;
}

function toPostView(entry: PostEntry): PostView {
  const sourcePath = postSourcePath(entry);
  // Validated for the path rules (kebab-case, reserved names, extensions), but
  // its directory list is not reused for routing.
  parseContentPath(sourcePath);

  const body = entry.body ?? "";
  return {
    id: entry.id,
    url: postUrl(entry.id),
    sourcePath,
    segments: idSegments(entry.id),
    data: entry.data,
    body,
    readingMinutes: readingTime(body).minutes,
  };
}

/**
 * Derive a directory's display title from its path when no `_index.md`
 * provides one. Hyphens become spaces; nothing is translated, re-cased or
 * guessed at.
 */
function derivedTitle(segments: readonly string[]): string {
  const last = segments.at(-1) ?? "";
  return last.replace(/-/gu, " ");
}

/* -------------------------------------------------------------------------- */
/* Directory tree                                                              */
/* -------------------------------------------------------------------------- */

interface MutableDirectory {
  segments: string[];
  title: string;
  description: string;
  indexEntryId: string | null;
  order: number;
  children: Map<string, MutableDirectory>;
  posts: PostView[];
}

function ensureDirectory(
  root: MutableDirectory,
  segments: readonly string[],
): MutableDirectory {
  let current = root;
  const walked: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    let next = current.children.get(segment);
    if (next === undefined) {
      next = {
        segments: [...walked],
        title: derivedTitle(walked),
        description: DEFAULT_INDEX_DESCRIPTION,
        indexEntryId: null,
        order: 0,
        children: new Map(),
        posts: [],
      };
      current.children.set(segment, next);
    }
    current = next;
  }
  return current;
}

function finalizeDirectory(directory: MutableDirectory): DirectoryView {
  const children = [...directory.children.values()]
    .map(finalizeDirectory)
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });

  const posts = [...directory.posts].sort(comparePosts);

  return {
    segments: directory.segments,
    url: directoryUrl(directory.segments),
    title: directory.title,
    description: directory.description,
    indexEntryId: directory.indexEntryId,
    order: directory.order,
    children,
    posts,
    directPosts: posts,
  };
}

/**
 * A directory's subtree posts are the union of its own and its descendants'.
 * Computed after the tree is built so each node is visited once.
 */
function subtreePosts(view: DirectoryView): PostView[] {
  const all = [...view.directPosts];
  for (const child of view.children) {
    all.push(...subtreePosts(child));
  }
  return all.sort(comparePosts);
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

let cached: Promise<Site> | undefined;

/** Drop the memoised site. Test-only. */
export function resetSiteCache(): void {
  cached = undefined;
}

/**
 * Load and index all content for one build.
 *
 * The result is memoised for the life of the build: every page renders from the
 * same snapshot, so a long build cannot observe two different versions of the
 * content.
 */
export function loadSite(): Promise<Site> {
  cached ??= buildSite();
  return cached;
}

async function buildSite(): Promise<Site> {
  const now = buildNow();

  const [postEntries, indexEntries, pageEntries] = await Promise.all([
    getCollection("posts"),
    getCollection("postIndexes"),
    getCollection("pages"),
  ]);

  const posts = postEntries
    .filter((entry) => isPublicAt(entry.data, now))
    .map(toPostView)
    .sort(comparePosts);

  // --- directories -------------------------------------------------------

  const root: MutableDirectory = {
    segments: [],
    title: "文章",
    description: DEFAULT_INDEX_DESCRIPTION,
    indexEntryId: null,
    order: 0,
    children: new Map(),
    posts: [],
  };

  // A directory exists because a post lives in it, or because it owns an
  // `_index.md`. Both cases must produce a route.
  for (const post of posts) {
    ensureDirectory(root, post.segments).posts.push(post);
  }
  for (const entry of indexEntries) {
    parseContentPath(indexSourcePath(entry));
    ensureDirectory(root, indexSegments(entry));
  }

  // Apply `_index.md` metadata, but only when it is public.
  for (const entry of indexEntries) {
    parseContentPath(indexSourcePath(entry));
    const directory = ensureDirectory(root, indexSegments(entry));
    const meta: IndexFrontmatter = entry.data;

    directory.order = meta.order;
    if (isPublicAt(meta, now)) {
      directory.title = meta.title;
      directory.description = meta.description;
      directory.indexEntryId =
        entry.body === undefined || entry.body.trim().length === 0
          ? null
          : entry.id;
    } else {
      // A draft index still generates its directory page and still contributes
      // its ordering, but its custom prose and title are ignored.
      directory.description = DEFAULT_INDEX_DESCRIPTION;
    }
  }

  const finalizedRoot = finalizeDirectory(root);
  const directories = new Map<string, DirectoryView>();

  const indexDirectory = (directory: DirectoryView): DirectoryView => {
    const withSubtree: DirectoryView = {
      ...directory,
      posts: subtreePosts(directory),
    };
    directories.set(withSubtree.segments.join("/"), withSubtree);
    for (const child of withSubtree.children) {
      indexDirectory(child);
    }
    return withSubtree;
  };

  const rootView = indexDirectory(finalizedRoot);

  // --- tags --------------------------------------------------------------

  const tagMap = new Map<string, { label: string; count: number }>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const existing = tagMap.get(tag.id);
      if (existing === undefined) {
        tagMap.set(tag.id, { label: tag.label, count: 1 });
      } else {
        existing.count += 1;
      }
    }
  }

  const tags: TagView[] = [...tagMap.entries()]
    .map(([id, value]) => ({
      id,
      label: value.label,
      count: value.count,
      url: tagUrl(id),
    }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.id < b.id ? -1 : 1,
    );

  // --- series ------------------------------------------------------------

  const seriesMap = new Map<string, { title: string; posts: PostView[] }>();
  for (const post of posts) {
    const series = post.data.series;
    if (series === undefined) continue;
    const existing = seriesMap.get(series.id);
    if (existing === undefined) {
      seriesMap.set(series.id, { title: series.title, posts: [post] });
    } else {
      existing.posts.push(post);
    }
  }

  const series: SeriesView[] = [...seriesMap.entries()]
    .map(([id, value]) => {
      const ordered = [...value.posts].sort((a, b) => {
        const orderA = a.data.series?.order ?? 0;
        const orderB = b.data.series?.order ?? 0;
        return orderA - orderB;
      });
      const latest = ordered.reduce(
        (acc, post) =>
          Date.parse(post.data.publishedAt) > Date.parse(acc)
            ? post.data.publishedAt
            : acc,
        ordered[0]?.data.publishedAt ?? new Date(0).toISOString(),
      );
      return {
        id,
        title: value.title,
        url: seriesUrl(id),
        count: ordered.length,
        posts: ordered,
        latest,
      };
    })
    .sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest));

  // --- archive -----------------------------------------------------------

  const archive = buildArchive(posts);

  // --- pages -------------------------------------------------------------

  const pages = new Map<string, PageView>();
  for (const entry of pageEntries) {
    // Pages need the same path rules the posts collection gets: the id becomes
    // the public URL, so an uppercase segment, a reserved name, or a
    // `_index.md` would otherwise reach the sitemap as a route this site does
    // not mean to serve.
    parseContentPath(pageSourcePath(entry));

    if (!isPublicAt(entry.data, now)) continue;
    pages.set(entry.id, {
      id: entry.id,
      url: pageUrl(entry.id),
      data: entry.data,
      body: entry.body ?? "",
    });
  }

  return {
    buildNow: now,
    posts,
    tags,
    series,
    archive,
    directories,
    root: rootView,
    pages,
    about: pages.get("about") ?? null,
  };
}

/**
 * Group public posts by year and month, both newest first, using the site time
 * zone so a late-evening post does not slide into the previous day's bucket.
 *
 * The zone comes from `SITE_TIME_ZONE`, the same single source every other date
 * decision reads. It used to be the literal `Asia/Taipei` here, which meant
 * changing the site's zone moved the article timestamps and the archive's
 * buckets apart.
 */
function buildArchive(posts: readonly PostView[]): ArchiveYear[] {
  const yearFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    year: "numeric",
  });
  const monthFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    month: "2-digit",
  });

  const years = new Map<string, Map<string, PostView[]>>();

  for (const post of posts) {
    const date = new Date(post.data.publishedAt);
    const year = yearFormatter.format(date);
    const month = monthFormatter.format(date);
    let months = years.get(year);
    if (months === undefined) {
      months = new Map();
      years.set(year, months);
    }
    const bucket = months.get(month);
    if (bucket === undefined) {
      months.set(month, [post]);
    } else {
      bucket.push(post);
    }
  }

  return [...years.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, months]) => {
      const monthViews: ArchiveMonth[] = [...months.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([month, monthPosts]) => ({
          month,
          label: `${year}-${month}`,
          posts: [...monthPosts].sort(comparePosts),
        }));
      return {
        year,
        count: monthViews.reduce((acc, view) => acc + view.posts.length, 0),
        months: monthViews,
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

export function postsWithTag(site: Site, tagId: string): PostView[] {
  return site.posts.filter((post) =>
    post.data.tags.some((tag) => tag.id === tagId),
  );
}

export function seriesPosts(site: Site, seriesId: string): PostView[] {
  return (
    site.series.find((entry) => entry.id === seriesId)?.posts.slice() ?? []
  );
}

export {
  homePageUrl,
  archivePageUrl,
  directoryPageUrl,
  tagPageUrl,
  seriesPageUrl,
  PAGE_SIZE,
};

/** Re-exported so callers do not need to import the path helpers directly. */
export { ancestorDirectories };

/**
 * Related-article scoring lives in `./related.ts`, which has no Astro imports
 * and can therefore be unit tested on its own.
 */
export { relatedPosts, relatedScore, type ScorablePost } from "./related.js";
