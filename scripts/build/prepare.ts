import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ANI_CONTENT_DIR,
  CONTENT_WORKSPACE_DIR,
  MEDIA_WORKSPACE_DIR,
  PROJECT_ROOT,
} from "../../src/lib/content/paths.js";
import { deriveAsset } from "../../src/lib/media/process.js";
import type { MediaAsset, MediaIndex } from "../../src/lib/media/index.js";

/**
 * Materialise exactly one content source into `.ani-content/runtime`.
 *
 * Four modes exist and only one can be active at a time:
 *
 *   empty      no workspace, no content — the state the site ships in
 *   workspace  the author's own working copy
 *   fixtures   isolated test content, never part of a real build
 *   r2         a pulled, immutable release (what Cloudflare Pages builds)
 *
 * Everything downstream — the content loaders, the media index, the Open Graph
 * renderer — reads only `.ani-content/runtime`, so a fixture build is
 * structurally incapable of reading real content and vice versa.
 */

export type ContentSource = "empty" | "workspace" | "fixtures" | "r2";

const RUNTIME_DIR = path.join(ANI_CONTENT_DIR, "runtime");
const RUNTIME_CONTENT = path.join(RUNTIME_DIR, "content");
const RUNTIME_MEDIA = path.join(RUNTIME_DIR, "media");

const FIXTURES_DIR = path.join(PROJECT_ROOT, "tests", "fixtures");
const FIXTURES_CONTENT = path.join(FIXTURES_DIR, "content");
const FIXTURES_MEDIA = path.join(FIXTURES_DIR, "media");

export interface PrepareOptions {
  readonly source: ContentSource;
  readonly log: (message: string) => void;
}

export interface PrepareResult {
  readonly source: ContentSource;
  readonly releaseId: string | null;
  readonly digest: string | null;
  readonly posts: number;
  readonly media: number;
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Assert a path is inside `.ani-content` before it is removed.
 *
 * Nothing in this project deletes a directory it has not first proved it owns.
 */
function assertInsideAniContent(target: string): void {
  const resolved = path.resolve(target);
  const root = path.resolve(ANI_CONTENT_DIR);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify ${resolved}: it is outside ${root}.`);
  }
}

/**
 * Discard Astro's content-layer caches.
 *
 * Two locations matter, and only clearing both actually works:
 *
 * - `.astro/` holds the generated module graph (`content-modules.mjs`) and the
 *   collection schemas.
 * - `node_modules/.astro/` holds the persisted data store. This is the one that
 *   bites: it survives deleting `.astro/`, so a build that only removed `.astro`
 *   regenerates the module graph straight from the stale store.
 *
 * The failure this prevents is concrete. The glob loader returns early when a
 * pattern matches nothing, without clearing the entries a previous sync left
 * behind — so building fixtures and then building empty leaves the fixture
 * documents in the store, and Vite then tries to resolve an import for a file
 * that no longer exists. Clearing both caches means every build starts from the
 * source it was actually given.
 *
 * Both directories are generated, git-ignored output.
 */
async function clearAstroCache(): Promise<void> {
  const targets = [
    path.join(PROJECT_ROOT, ".astro"),
    path.join(PROJECT_ROOT, "node_modules", ".astro"),
  ];

  for (const target of targets) {
    if (await exists(target)) {
      await rm(target, { recursive: true, force: true });
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  }

  if (await exists(root)) await walk(root);
  return found.sort();
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

interface SidecarMetadata {
  readonly alt?: string;
  readonly credit?: string;
  readonly license?: string;
}

/** Image extensions the fixture pipeline accepts. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

/**
 * Process a directory of source images into the runtime media tree.
 *
 * Each source may be accompanied by a `<name>.json` sidecar holding its `alt`
 * text, credit and licence. Media without a sidecar is still usable — it simply
 * carries whatever the caller supplies — but `content:validate` reports an
 * article whose cover has no meaningful alt.
 */
async function materialiseMedia(
  sourceDir: string,
  log: (message: string) => void,
): Promise<MediaIndex> {
  const assets: MediaAsset[] = [];

  if (!(await exists(sourceDir))) {
    return { schemaVersion: 1, assets };
  }

  const files = (await listFiles(sourceDir)).filter((file) =>
    IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );

  for (const file of files) {
    const source = await readFile(file);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    const sidecarPath = file.replace(/\.[^.]+$/u, ".json");
    let sidecar: SidecarMetadata = {};
    if (await exists(sidecarPath)) {
      sidecar = JSON.parse(
        await readFile(sidecarPath, "utf8"),
      ) as SidecarMetadata;
    }

    const derived = await deriveAsset({
      source,
      sourceName: path.relative(PROJECT_ROOT, file),
      sourceSha256,
    });

    for (const entry of derived.files) {
      const target = path.join(RUNTIME_MEDIA, entry.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    }

    assets.push({
      sourceSha256,
      kind: "image",
      mime: derived.mime,
      alt: sidecar.alt ?? "",
      width: derived.width,
      height: derived.height,
      bytes: derived.bytes,
      credit: sidecar.credit,
      license: sidecar.license,
      // The local copy used when rendering Open Graph cards. The largest WebP
      // is the closest thing to a canonical raster of the asset.
      localPath: path.posix.join(
        "media",
        derived.derivatives
          .find((entry) => entry.format === "webp")
          ?.path.replace("/media/", "") ??
          derived.files[0]?.relativePath ??
          "",
      ),
      derivatives: derived.derivatives,
    });

    log(
      `  media ${sourceSha256.slice(0, 12)} ← ${path.relative(PROJECT_ROOT, file)}`,
    );
  }

  // Sorted by digest so two runs over the same inputs produce byte-identical
  // indexes.
  assets.sort((a, b) => (a.sourceSha256 < b.sourceSha256 ? -1 : 1));
  return { schemaVersion: 1, assets };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Choose a mode when the caller did not name one. */
export async function detectSource(): Promise<ContentSource> {
  return (await exists(CONTENT_WORKSPACE_DIR)) ? "workspace" : "empty";
}

/**
 * Read `--source <mode>` from the command line.
 *
 * The content mode is always passed explicitly by a package script; it is never
 * taken from a query parameter or an environment variable the browser could
 * influence.
 */
export function parseSourceArg(argv: readonly string[]): ContentSource | null {
  const index = argv.indexOf("--source");
  const value = index === -1 ? null : argv[index + 1];
  if (value === null || value === undefined) return null;
  if (
    value === "empty" ||
    value === "workspace" ||
    value === "fixtures" ||
    value === "r2"
  ) {
    return value;
  }
  throw new Error(
    `Unknown --source ${JSON.stringify(value)}. Expected empty, workspace, fixtures or r2.`,
  );
}

export async function prepare(options: PrepareOptions): Promise<PrepareResult> {
  const { source, log } = options;

  if (source === "r2") {
    throw new Error(
      "The r2 source is materialised by `content:pull`, which verifies a release before writing it. " +
        "Run the pull step first.",
    );
  }

  // Start from nothing so a previous build cannot bleed into this one.
  assertInsideAniContent(RUNTIME_DIR);
  await rm(RUNTIME_DIR, { recursive: true, force: true });
  await clearAstroCache();
  await mkdir(path.join(RUNTIME_CONTENT, "posts"), { recursive: true });
  await mkdir(path.join(RUNTIME_CONTENT, "pages"), { recursive: true });
  await mkdir(RUNTIME_MEDIA, { recursive: true });

  let contentDir: string | null = null;
  let mediaDir: string | null = null;

  if (source === "workspace") {
    contentDir = CONTENT_WORKSPACE_DIR;
    mediaDir = MEDIA_WORKSPACE_DIR;
    if (!(await exists(contentDir))) {
      throw new Error(
        `No workspace at ${CONTENT_WORKSPACE_DIR}. Create one with \`pnpm content:pull --checkout\` or \`pnpm content:new\`.`,
      );
    }
  } else if (source === "fixtures") {
    contentDir = FIXTURES_CONTENT;
    mediaDir = FIXTURES_MEDIA;
    if (!(await exists(contentDir))) {
      throw new Error(`No fixtures at ${FIXTURES_CONTENT}.`);
    }
  }

  if (contentDir !== null) {
    for (const collection of ["posts", "pages"] as const) {
      const from = path.join(contentDir, collection);
      if (!(await exists(from))) continue;
      await cp(from, path.join(RUNTIME_CONTENT, collection), {
        recursive: true,
      });
    }
  }

  const media = await materialiseMedia(mediaDir ?? RUNTIME_MEDIA, log);

  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(
    path.join(RUNTIME_DIR, "media-index.json"),
    `${JSON.stringify(media, null, 2)}\n`,
    "utf8",
  );

  const contentFiles = await listFiles(RUNTIME_CONTENT);
  const digest = createHash("sha256");
  for (const file of contentFiles) {
    digest.update(path.relative(RUNTIME_CONTENT, file).replace(/\\/gu, "/"));
    digest.update(await readFile(file));
  }

  // The same shape the release pull writes, so a reader never has to know
  // which step produced the file.
  const sourceRecord = {
    schemaVersion: 1,
    mode: source,
    releaseId: null,
    contentDigest:
      contentFiles.length === 0 ? null : `sha256:${digest.digest("hex")}`,
    materializedAt: new Date().toISOString(),
    offline: false,
  };

  await writeFile(
    path.join(RUNTIME_DIR, "source.json"),
    `${JSON.stringify(sourceRecord, null, 2)}\n`,
    "utf8",
  );

  log(
    `content source: ${source} — ${contentFiles.length} file(s), ${media.assets.length} media asset(s)`,
  );

  return {
    source,
    releaseId: null,
    digest: sourceRecord.contentDigest,
    posts: contentFiles.filter((file) =>
      path
        .relative(RUNTIME_CONTENT, file)
        .replace(/\\/gu, "/")
        .startsWith("posts/"),
    ).length,
    media: media.assets.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Allow `tsx scripts/build/prepare.ts --source fixtures` for debugging and for
 * the verification scripts, which need to materialise one mode in isolation.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const requested = parseSourceArg(process.argv.slice(2));
  const source = requested ?? (await detectSource());
  const result = await prepare({
    source,
    log: (message) => console.log(message),
  });
  console.log(JSON.stringify(result, null, 2));
}
