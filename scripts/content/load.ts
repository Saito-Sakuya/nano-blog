import path from "node:path";

import "../lib/env.js";
import {
  ANI_CONTENT_DIR,
  CONTENT_CACHE_DIR,
  CONTENT_RUNTIME_DIR,
  CONTENT_WORKSPACE_DIR,
  MEDIA_WORKSPACE_DIR,
  PROJECT_ROOT,
  contentUrl,
  parseContentPath,
  urlToPath,
} from "../../src/lib/content/paths.js";
import {
  indexSchema,
  pageSchema,
  postSchema,
} from "../../src/lib/content/schema.js";
import type {
  IndexFrontmatter,
  PageFrontmatter,
  PostFrontmatter,
} from "../../src/lib/content/schema.js";
import { ValidationError } from "../lib/errors.js";
import {
  listFilesRecursive,
  pathExists,
  readBytes,
  readJsonFile,
} from "../lib/fs-util.js";
import { hasBinaryControlCharacters } from "../lib/unicode.js";
import { parseMediaMeta, type MediaMeta } from "../media/meta.js";
import { parseDocument } from "./frontmatter.js";

/**
 * Loading a content source.
 *
 * One loader for all four sources — the author workspace, the materialised
 * runtime, an arbitrary directory and the empty set — so validation, publishing
 * and the author commands all see content the same way. The source is read from
 * disk and each file is checked against the same Zod schema the Astro build
 * uses; nothing here renders Markdown or resolves routes.
 */

export type ContentSourceKind =
  "empty" | "workspace" | "runtime" | "fixtures" | "directory";

export type ContentCollection = "posts" | "postIndexes" | "pages";

export interface ContentIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly field?: string;
}

export interface ContentEntry {
  readonly collection: ContentCollection;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly collectionPath: string;
  readonly url: string;
  readonly source: string;
  readonly data: Record<string, unknown>;
  /** Validated frontmatter, or null when the schema rejected it. */
  readonly parsed: PostFrontmatter | PageFrontmatter | IndexFrontmatter | null;
  readonly body: string;
  readonly bodyStartLine: number;
  readonly bytes: number;
  readonly issues: readonly ContentIssue[];
}

export interface ContentSource {
  readonly kind: ContentSourceKind;
  readonly root: string;
  readonly label: string;
  readonly entries: readonly ContentEntry[];
  readonly issues: readonly ContentIssue[];
  readonly mediaRecords: ReadonlyMap<string, MediaMeta>;
}

export interface LoadContentOptions {
  readonly root: string;
  readonly kind: ContentSourceKind;
  readonly label?: string;
  /** Where local media records live; defaults to the workspace media directory. */
  readonly mediaDir?: string;
  readonly readMediaRecords?: boolean;
}

function collectionFor(collectionPath: string): ContentCollection {
  if (collectionPath.startsWith("posts/")) {
    return collectionPath.endsWith("/_index.md") ||
      collectionPath === "posts/_index.md"
      ? "postIndexes"
      : "posts";
  }
  return "pages";
}

function schemaIssues(
  result: {
    success: false;
    error: { issues: readonly { path: PropertyKey[]; message: string }[] };
  },
  file: string,
): ContentIssue[] {
  return result.error.issues.map((issue) => ({
    severity: "error" as const,
    code: "schema",
    message: issue.message,
    file,
    field:
      issue.path.length === 0 ? "(root)" : issue.path.map(String).join("."),
  }));
}

export async function loadContentSource(
  options: LoadContentOptions,
): Promise<ContentSource> {
  const label = options.label ?? options.kind;
  const issues: ContentIssue[] = [];
  const entries: ContentEntry[] = [];

  if (options.kind !== "empty" && !(await pathExists(options.root))) {
    throw new ValidationError(
      `The ${label} content directory ${options.root} does not exist.`,
    );
  }

  if (options.kind !== "empty") {
    const files = await listFilesRecursive(options.root);

    for (const file of files) {
      const relativePath = file.relativePath;

      if (!/\.(md|mdx)$/u.test(relativePath)) {
        issues.push({
          severity: "error",
          code: "unexpected-file",
          message: `Only .md and .mdx files belong in a content source; ${relativePath} does not.`,
          file: relativePath,
        });
        continue;
      }

      if (options.kind === "fixtures" && relativePath.startsWith("_")) {
        continue;
      }

      if (
        !relativePath.startsWith("posts/") &&
        !relativePath.startsWith("pages/")
      ) {
        issues.push({
          severity: "error",
          code: "path",
          message: `${relativePath} is directly under the content root; content lives under posts/ or pages/.`,
          file: relativePath,
        });
        continue;
      }

      const collectionPath = relativePath
        .replace(/^posts\//u, "")
        .replace(/^pages\//u, "");
      const collection = collectionFor(relativePath);

      const bytes = await readBytes(file.absolutePath);
      const source = Buffer.from(bytes).toString("utf8");

      let data: Record<string, unknown> = {};
      let body = "";
      let bodyStartLine = 1;
      const entryIssues: ContentIssue[] = [];

      // A NUL or other binary control byte is not something an author types;
      // it means the file is not the UTF-8 text the release format requires.
      // Tab, LF and CR are ordinary text and are not flagged here.
      if (hasBinaryControlCharacters(source)) {
        entryIssues.push({
          severity: "error",
          code: "control-character",
          message:
            "The file contains a binary control character (NUL or similar); content files must be plain UTF-8 text with LF line endings.",
          file: relativePath,
        });
      }

      try {
        const parsed = parseDocument(source, relativePath);
        data = parsed.data;
        body = parsed.body;
        bodyStartLine = parsed.bodyStartLine;
      } catch (error) {
        entryIssues.push({
          severity: "error",
          code: "frontmatter",
          message: error instanceof Error ? error.message : String(error),
          file: relativePath,
        });
      }

      try {
        parseContentPath(relativePath);
      } catch (error) {
        entryIssues.push({
          severity: "error",
          code: "path",
          message: error instanceof Error ? error.message : String(error),
          file: relativePath,
        });
      }

      let parsedFrontmatter:
        PostFrontmatter | PageFrontmatter | IndexFrontmatter | null = null;
      let url = "";

      if (entryIssues.length === 0) {
        try {
          url = contentUrl(relativePath);
        } catch {
          url = "";
        }

        const schema =
          collection === "posts"
            ? postSchema
            : collection === "pages"
              ? pageSchema
              : indexSchema;
        const result = schema.safeParse(data);

        if (result.success) {
          parsedFrontmatter = result.data as
            PostFrontmatter | PageFrontmatter | IndexFrontmatter;
        } else {
          entryIssues.push(...schemaIssues(result, relativePath));
        }
      }

      entries.push({
        collection,
        relativePath,
        absolutePath: file.absolutePath,
        collectionPath,
        url,
        source,
        data,
        parsed: parsedFrontmatter,
        body,
        bodyStartLine,
        bytes: file.bytes,
        issues: entryIssues,
      });

      issues.push(...entryIssues);
    }

    entries.sort((a, b) =>
      a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0,
    );
  }

  const mediaRecords =
    options.readMediaRecords === false
      ? new Map<string, MediaMeta>()
      : await loadMediaRecords(options.mediaDir ?? MEDIA_WORKSPACE_DIR);

  return {
    kind: options.kind,
    root: options.root,
    label,
    entries,
    issues,
    mediaRecords,
  };
}

async function loadMediaRecords(
  mediaDir: string,
): Promise<Map<string, MediaMeta>> {
  const records = new Map<string, MediaMeta>();
  if (!(await pathExists(mediaDir))) return records;

  for (const entry of await listFilesRecursive(mediaDir)) {
    if (!entry.relativePath.endsWith("/meta.json")) continue;
    const digest = entry.relativePath.split("/")[0];
    if (digest === undefined) continue;
    try {
      records.set(
        digest,
        parseMediaMeta(
          await readJsonFile(entry.absolutePath),
          entry.relativePath,
        ),
      );
    } catch {
      // A malformed record is reported by `content:validate`, which loads the
      // file itself and can say what is wrong with it.
    }
  }

  return records;
}

/** The runtime directory the Astro build reads. */
export const RUNTIME_CONTENT_DIR = urlToPath(CONTENT_RUNTIME_DIR);

/**
 * The checked-in fixture content.
 *
 * `scripts/build/prepare.ts` materialises this same directory into the runtime
 * for `--source fixtures`; reading it directly is what lets a local command ask
 * for the fixtures without depending on a build having run first.
 */
export const FIXTURE_CONTENT_DIR = path.join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "content",
);

export interface ResolvedSource {
  readonly kind: ContentSourceKind;
  readonly root: string;
  readonly label: string;
}

/** Where each named kind lives, for the kinds whose location is fixed. */
function fixedRootFor(kind: ContentSourceKind): string | null {
  switch (kind) {
    case "workspace":
      return CONTENT_WORKSPACE_DIR;
    case "runtime":
      return RUNTIME_CONTENT_DIR;
    case "fixtures":
      return FIXTURE_CONTENT_DIR;
    case "empty":
      return path.join(ANI_CONTENT_DIR, "runtime", "content");
    case "directory":
      // A directory source is only meaningful with `--path`; there is no
      // default location to fall back to.
      return null;
  }
}

/**
 * Which source a local command should use.
 *
 * An explicit `--path` wins outright. An explicit `--source` is then honoured
 * for the kinds that have a fixed location — `--source fixtures` used to be
 * dropped on the floor, so the command read the author's workspace instead and
 * reported on content nobody had asked about. Only when neither is given does
 * the workspace-then-runtime search below decide.
 */
export async function resolveLocalSource(explicit?: {
  readonly kind?: ContentSourceKind;
  readonly root?: string;
}): Promise<ResolvedSource> {
  if (explicit?.root !== undefined) {
    const kind = explicit.kind ?? "directory";
    return {
      kind,
      root: path.resolve(PROJECT_ROOT, explicit.root),
      label: kind === "directory" ? "directory" : kind,
    };
  }

  if (explicit?.kind !== undefined) {
    const root = fixedRootFor(explicit.kind);
    if (root === null) {
      throw new ValidationError(
        "--source directory needs --path <dir>; there is no default directory to read.",
      );
    }
    const label = labelForKind(explicit.kind);
    if (explicit.kind !== "empty" && !(await pathExists(root))) {
      throw new ValidationError(
        `The ${label} content directory ${root} does not exist.`,
      );
    }
    return { kind: explicit.kind, root, label };
  }

  if (await pathExists(CONTENT_WORKSPACE_DIR)) {
    return {
      kind: "workspace",
      root: CONTENT_WORKSPACE_DIR,
      label: "author workspace",
    };
  }

  if (await pathExists(RUNTIME_CONTENT_DIR)) {
    return {
      kind: "runtime",
      root: RUNTIME_CONTENT_DIR,
      label: "materialised runtime",
    };
  }

  return {
    kind: "empty",
    root: path.join(ANI_CONTENT_DIR, "runtime", "content"),
    label: "empty",
  };
}

/** The human name a kind is reported under. */
function labelForKind(kind: ContentSourceKind): string {
  switch (kind) {
    case "workspace":
      return "author workspace";
    case "runtime":
      return "materialised runtime";
    case "fixtures":
      return "fixtures";
    case "empty":
      return "empty";
    case "directory":
      return "directory";
  }
}

export {
  ANI_CONTENT_DIR,
  CONTENT_CACHE_DIR,
  CONTENT_WORKSPACE_DIR,
  MEDIA_WORKSPACE_DIR,
};
