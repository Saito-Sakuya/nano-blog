import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Path rules for content and for the routes it produces.
 *
 * There is exactly one mapping from a content file to a public URL, and it has
 * no exceptions: a file's directory path *is* its URL path. Dates never appear
 * in a URL, so retitling an article cannot move it, and a path change is only
 * ever expressed as an explicit redirect.
 */

/** Repository root, as an absolute path. */
export const PROJECT_ROOT = process.cwd();

/** `.ani-content` — everything the build materialises, never committed. */
export const ANI_CONTENT_DIR = path.join(PROJECT_ROOT, ".ani-content");

/** Directory the loaders read for the current build. */
export const CONTENT_RUNTIME_DIR = pathToFileURL(
  path.join(ANI_CONTENT_DIR, "runtime", "content") + path.sep,
);

/** Validated, immutable downloads of R2 releases. */
export const CONTENT_CACHE_DIR = path.join(
  ANI_CONTENT_DIR,
  "cache",
  "releases",
);

/** The author's editable copy of the content. */
export const CONTENT_WORKSPACE_DIR = path.join(
  ANI_CONTENT_DIR,
  "workspace",
  "content",
);

/** Media derivatives produced locally but not necessarily uploaded. */
export const MEDIA_WORKSPACE_DIR = path.join(
  ANI_CONTENT_DIR,
  "workspace",
  "media",
);

/** Manual Workers AI suggestions. */
export const SEO_SUGGESTIONS_DIR = path.join(
  ANI_CONTENT_DIR,
  "seo-suggestions",
);

/** A single path segment of a file or directory name. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Names Windows reserves for devices, in every directory and with any
 * extension: `nul.md` is still the null device on Windows, so it cannot be
 * checked out, copied or served from a Windows build machine. The comparison is
 * case-insensitive because the reservation is.
 */
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * The largest a single path segment may be, in bytes.
 *
 * 255 bytes is the limit shared by ext4, APFS and NTFS. A longer name may be
 * accepted by the machine that wrote it and rejected by the one that checks the
 * release out, which is exactly the kind of difference a path rule exists to
 * catch before publishing.
 */
const MAX_SEGMENT_BYTES = 255;

/** Directory name reserved for pagination routes (`/posts/<dir>/page/2/`). */
export const RESERVED_DIRECTORY_SEGMENT = "page";

/**
 * Sentinel entry id for `posts/_index.md`, the index of the posts root.
 *
 * A real directory segment must match `[a-z0-9]+(-[a-z0-9]+)*`, so a leading
 * underscore can never collide with one.
 */
export const ROOT_INDEX_ID = "_root";

/** File extensions content may use. */
export const CONTENT_EXTENSIONS = [".md", ".mdx"] as const;

export type ContentExtension = (typeof CONTENT_EXTENSIONS)[number];

export interface ParsedContentPath {
  /** Path relative to the collection root, always POSIX-separated. */
  readonly relativePath: string;
  /** Directory segments, excluding the file name. */
  readonly directories: readonly string[];
  /** File name without its extension. */
  readonly stem: string;
  readonly extension: ContentExtension;
  /** True when the file is a directory index. */
  readonly isIndex: boolean;
}

export class ContentPathError extends Error {
  override readonly name = "ContentPathError";
}

/**
 * Reject the names a filesystem cannot store, whatever the kebab-case rule
 * says. These are properties of the name rather than of the URL, so they are
 * checked first: `nul.md` is a perfectly good slug and still an unwritable
 * file.
 */
function assertStorableSegment(segment: string, relativePath: string): void {
  if (segment.includes(":")) {
    throw new ContentPathError(
      `Segment ${JSON.stringify(segment)} in ${relativePath} contains ":", which names an NTFS alternate data stream rather than a file.`,
    );
  }
  if (WINDOWS_RESERVED_NAME.test(segment)) {
    throw new ContentPathError(
      `Segment ${JSON.stringify(segment)} in ${relativePath} is a reserved Windows device name; Windows cannot store it.`,
    );
  }
  if (Buffer.byteLength(segment, "utf8") >= MAX_SEGMENT_BYTES) {
    throw new ContentPathError(
      `Segment ${JSON.stringify(segment)} in ${relativePath} is ${Buffer.byteLength(segment, "utf8")} bytes long; filesystems allow fewer than ${MAX_SEGMENT_BYTES}.`,
    );
  }
}

/**
 * Validate and decompose a content path.
 *
 * Anything that could produce an ambiguous URL — an uppercase segment, an
 * underscore other than `_index`, an `index.md`, an unsupported extension — is
 * rejected here rather than being normalised into something that might collide
 * with another file on a case-insensitive filesystem.
 *
 * Two further classes are refused because the *filesystem* cannot represent
 * them: names Windows reserves for devices (`nul`, `com1`, …) and NTFS
 * alternate data streams (`name:stream`), plus any segment longer than a
 * filesystem allows. A path that cannot be checked out on the machine building
 * the release is not a path this site can serve.
 */
export function parseContentPath(relativePath: string): ParsedContentPath {
  const normalized = relativePath.replace(/\\/gu, "/");

  if (normalized.startsWith("/") || normalized.includes("//")) {
    throw new ContentPathError(
      `Content path must be relative and normalised: ${relativePath}`,
    );
  }
  if (normalized.includes("\0")) {
    throw new ContentPathError(
      `Content path contains a NUL byte: ${relativePath}`,
    );
  }

  const segments = normalized.split("/");
  const fileName = segments.at(-1);
  if (fileName === undefined || fileName.length === 0) {
    throw new ContentPathError(
      `Content path has no file name: ${relativePath}`,
    );
  }
  // The file name is a segment too: the same limits that make a directory
  // unwritable make a file unwritable.
  assertStorableSegment(fileName, relativePath);

  const extension = path.posix.extname(fileName).toLowerCase();
  if (!isContentExtension(extension)) {
    throw new ContentPathError(
      `Content file must end in .md or .mdx, but ${relativePath} ends in ${extension || "(nothing)"}.`,
    );
  }

  const stem = fileName.slice(0, fileName.length - extension.length);
  const directories = segments.slice(0, -1);

  for (const segment of directories) {
    assertStorableSegment(segment, relativePath);
    if (!SEGMENT.test(segment)) {
      throw new ContentPathError(
        `Directory segment ${JSON.stringify(segment)} in ${relativePath} must be lower-case kebab-case.`,
      );
    }
    // Pagination owns `page/<n>` at every directory level, so a real directory
    // may not claim the name.
    if (segment === RESERVED_DIRECTORY_SEGMENT) {
      throw new ContentPathError(
        `Directory segment ${JSON.stringify(segment)} in ${relativePath} is reserved for pagination.`,
      );
    }
  }

  if (stem === "index") {
    throw new ContentPathError(
      `${relativePath} uses "index"; directory indexes must be named "_index.md".`,
    );
  }

  const isIndex = stem === "_index";
  if (!isIndex && !SEGMENT.test(stem)) {
    throw new ContentPathError(
      `File name ${JSON.stringify(stem)} in ${relativePath} must be lower-case kebab-case, or "_index".`,
    );
  }

  /*
   * A directory index under `pages/` has no URL.
   *
   * The pages collection is stored flat at the site root, so `pages/_index.md`
   * would produce `/` — the home page — and `pages/lab/_index.md` would produce
   * `/lab/_index/`. Index files are a posts-collection idea: only there does a
   * directory own a route of its own. Refusing the name here means the loader
   * reports it as a path error instead of the site quietly serving a wrong URL.
   */
  if (isIndex && directories[0] === "pages") {
    throw new ContentPathError(
      `${relativePath} is a directory index under pages/, which has no directory routes; name it pages/<slug>.md instead.`,
    );
  }

  return {
    relativePath: normalized,
    directories,
    stem,
    extension,
    isIndex,
  };
}

function isContentExtension(value: string): value is ContentExtension {
  return (CONTENT_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * The public URL a content file produces.
 *
 * - `posts/dev/web/a.md`   → `/posts/dev/web/a/`
 * - `posts/dev/web/_index.md` → `/posts/dev/web/`
 * - `posts/_index.md`      → `/posts/`
 * - `pages/about.md`       → `/about/`
 * - `pages/_index.md`      → refused: a pages directory has no route of its own
 */
export function contentUrl(relativePath: string): string {
  const parsed = parseContentPath(relativePath);
  const [collection, ...rest] = parsed.directories;

  if (collection === "posts") {
    // The posts prefix is part of the public URL, so it is kept.
    if (parsed.isIndex) {
      return rest.length === 0 ? "/posts/" : `/posts/${rest.join("/")}/`;
    }
    return `/posts/${[...rest, parsed.stem].join("/")}/`;
  }

  if (collection === "pages") {
    // Pages live at the site root: `pages/about.md` is `/about/`, not
    // `/pages/about/`, because the collection is a storage detail rather than
    // part of the address. `_index` never reaches this branch: the pages
    // collection has no directory routes, so `parseContentPath` refuses it.
    if (rest.length === 0) {
      return `/${parsed.stem}/`;
    }
    return `/${rest.join("/")}/${parsed.stem}/`;
  }

  throw new ContentPathError(
    `Content path ${relativePath} must start with "posts/" or "pages/".`,
  );
}

/**
 * Every ancestor directory of a posts path, as repository-relative directory
 * paths, outermost first. Used to build breadcrumbs and to emit an index route
 * for each level even when no `_index.md` exists.
 */
export function ancestorDirectories(
  directories: readonly string[],
): string[][] {
  const result: string[][] = [];
  for (let depth = 1; depth <= directories.length; depth += 1) {
    result.push(directories.slice(0, depth));
  }
  return result;
}

/** Convert an absolute file path to a repository-relative POSIX path. */
export function toPosixRelative(absolutePath: string): string {
  return path.relative(PROJECT_ROOT, absolutePath).replace(/\\/gu, "/");
}

/** Convert a file URL to an absolute filesystem path. */
export function urlToPath(url: URL): string {
  return fileURLToPath(url);
}
