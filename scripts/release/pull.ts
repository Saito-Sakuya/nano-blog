import path from "node:path";

import type { MediaIndex } from "../../src/lib/media/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency.js";
import { ValidationError } from "../lib/errors.js";
import {
  copyFileEntries,
  ensureDirectory,
  listFilesRecursive,
  pathExists,
  readBytes,
  readJsonFile,
  replaceDirectoryAtomically,
  withStagingDirectory,
  writeFileAtomic,
  writeJsonFile,
} from "../lib/fs-util.js";
import {
  assertNoCaseCollisions,
  assertSafeRelativePath,
  resolveWithin,
} from "../lib/safe-paths.js";
import { sortByCodePoints } from "../lib/unicode.js";
import { FILE_MAX_BYTES } from "../media/signature.js";
import { sha256Hex } from "./digest.js";
import {
  contentObjectKey,
  CONTENT_LIMITS,
  contentDigestOf,
  parseManifest,
  type ReleaseManifest,
} from "./manifest.js";
import type { StorageAdapter } from "./storage.js";

/**
 * Downloading and materialising a release.
 *
 * The failure mode this module exists to prevent is a half-updated
 * `.ani-content/runtime`: a build that reads half of yesterday's release and
 * half of today's produces a site that exists nowhere else and is wrong in
 * ways nobody can reproduce afterwards.
 *
 * So the order is always: download everything into a staging directory, verify
 * every byte against the manifest, and only then swap the directory into place.
 * The swap itself moves the old directory aside first and restores it if the
 * rename fails, which is the closest a directory rename gets to atomic.
 *
 * Nothing here ever writes to the bucket.
 */

export const SOURCE_FILE_NAME = "source.json";

export interface SourceRecord {
  readonly schemaVersion: number;
  readonly mode: "r2" | "workspace" | "fixtures" | "empty";
  readonly releaseId: string | null;
  readonly contentDigest: string | null;
  readonly materializedAt: string;
  /**
   * Set when the runtime came from an already-verified local cache under an
   * explicit `--offline`. The build renders a banner for it, because a cache
   * that was correct when it was written has not been re-checked against the
   * bucket in this build.
   */
  readonly offline?: boolean;
}

/**
 * Where a release's verified copy lives.
 *
 * There is deliberately no "ready" flag. A cache entry is either complete or it
 * is not, and that is decided by `readVerifiedCache`, which checks that both
 * paths exist, parses the manifest, re-hashes every file and compares the
 * result with the recorded digest. A boolean set once at construction time
 * could only restate what the caller already knew; the field that used to live
 * here was always `false` and read by nobody.
 */
export interface ReleaseCacheEntry {
  readonly releaseId: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly contentDir: string;
}

export function releaseCachePaths(
  cacheRoot: string,
  releaseId: string,
): ReleaseCacheEntry {
  const directory = path.join(cacheRoot, releaseId);
  return {
    releaseId,
    directory,
    manifestPath: path.join(directory, "manifest.json"),
    contentDir: path.join(directory, "content"),
  };
}

export interface PullReleaseOptions {
  readonly storage: StorageAdapter;
  readonly releaseId: string;
  readonly cacheRoot: string;
  /** Skip the network; the cache must already hold a verified copy. */
  readonly offline?: boolean;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly expectedDigest?: string;
}

export interface PulledRelease {
  readonly manifest: ReleaseManifest;
  readonly directory: string;
  readonly contentDir: string;
  readonly fromCache: boolean;
  readonly fileCount: number;
  readonly bytes: number;
}

async function fetchVerifiedContentObject(
  storage: StorageAdapter,
  manifest: ReleaseManifest,
  file: ReleaseManifest["files"][number],
): Promise<Uint8Array> {
  assertSafeRelativePath(file.path, "Manifest path");
  const key = contentObjectKey(manifest.releaseId, file.path);
  if (file.bytes > CONTENT_LIMITS.contentFileBytes) {
    throw new ValidationError(
      `${key} declares ${file.bytes} bytes, above the ${CONTENT_LIMITS.contentFileBytes}-byte limit.`,
    );
  }

  const data = await storage.get(key, {
    maxBytes: CONTENT_LIMITS.contentFileBytes,
  });
  if (data.bytes.byteLength !== file.bytes) {
    throw new ValidationError(
      `${key} is ${data.bytes.byteLength} bytes, but the manifest declares ${file.bytes}.`,
    );
  }

  const actual = sha256Hex(data.bytes);
  if (actual !== file.sha256) {
    throw new ValidationError(
      `${key} hashes to ${actual}, but the manifest declares ${file.sha256}. Refusing to materialise a release that does not match its manifest.`,
    );
  }
  return data.bytes;
}

/**
 * Read a cached release, if one is present and still matches its manifest.
 *
 * Verification recomputes the content digest from the files on disk, so a cache
 * that was tampered with, truncated or written by an older version of this
 * tooling is not silently reused.
 */
export async function readVerifiedCache(
  cacheRoot: string,
  releaseId: string,
): Promise<PulledRelease | null> {
  const paths = releaseCachePaths(cacheRoot, releaseId);
  if (
    !(await pathExists(paths.manifestPath)) ||
    !(await pathExists(paths.contentDir))
  ) {
    return null;
  }

  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(
      await readJsonFile(paths.manifestPath),
      paths.manifestPath,
    );
  } catch {
    return null;
  }

  if (manifest.releaseId !== releaseId) return null;

  const entries = sortByCodePoints(
    (await listFilesRecursive(paths.contentDir)).map(
      (entry) => entry.relativePath,
    ),
  );
  if (entries.length !== manifest.files.length) return null;

  let bytes = 0;
  for (const file of manifest.files) {
    const absolute = resolveWithin(
      paths.contentDir,
      file.path,
      "Cached content path",
    );
    if (!(await pathExists(absolute))) return null;
    const data = await readBytes(absolute);
    if (data.byteLength !== file.bytes || sha256Hex(data) !== file.sha256)
      return null;
    bytes += data.byteLength;
  }

  if (
    contentDigestOf(manifest.files, manifest.media) !== manifest.contentDigest
  )
    return null;

  return {
    manifest,
    directory: paths.directory,
    contentDir: paths.contentDir,
    fromCache: true,
    fileCount: manifest.files.length,
    bytes,
  };
}

/**
 * Fetch a release into the local cache.
 *
 * Downloads eight at a time, verifies each object's key, size and SHA-256
 * before it is written, and only then publishes the cache directory. A cache
 * directory is therefore always a complete, verified release or absent.
 */
export async function pullRelease(
  options: PullReleaseOptions,
): Promise<PulledRelease> {
  const cached = await readVerifiedCache(options.cacheRoot, options.releaseId);
  if (options.offline === true) {
    if (cached !== null) return cached;
    throw new ValidationError(
      `.ani-content/cache/releases/${options.releaseId} is missing or no longer matches its manifest, and --offline forbids downloading it.`,
    );
  }

  const manifestKey = `releases/${options.releaseId}/manifest.json`;
  const manifestData = await options.storage.get(manifestKey, {
    maxBytes: CONTENT_LIMITS.manifestBytes,
  });

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      Buffer.from(manifestData.bytes).toString("utf8"),
    );
  } catch (error) {
    throw new ValidationError(
      `${manifestKey} is not valid JSON: ${describe(error)}`,
    );
  }

  const manifest = parseManifest(manifestValue, manifestKey);
  if (manifest.releaseId !== options.releaseId) {
    throw new ValidationError(
      `${manifestKey} declares release ${manifest.releaseId}, not ${options.releaseId}.`,
    );
  }
  if (
    options.expectedDigest !== undefined &&
    manifest.contentDigest !== options.expectedDigest
  ) {
    throw new ValidationError(
      `The manifest for ${options.releaseId} has digest ${manifest.contentDigest}, but the pointer expects ${options.expectedDigest}.`,
    );
  }

  const expectedPaths = manifest.files.map((file) =>
    contentObjectKey(manifest.releaseId, file.path),
  );
  assertNoCaseCollisions(
    [...expectedPaths, manifestKey],
    `Release ${manifest.releaseId}`,
  );

  if (cached !== null) {
    if (JSON.stringify(cached.manifest) !== JSON.stringify(manifest)) {
      throw new ValidationError(
        `${manifestKey} no longer matches the manifest in the verified local cache. Release objects are immutable; refusing to use either copy.`,
      );
    }

    let completed = 0;
    await mapWithConcurrency(
      manifest.files,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (file) => {
        await fetchVerifiedContentObject(options.storage, manifest, file);
        completed += 1;
        options.onProgress?.(completed, manifest.files.length);
      },
    );
    return cached;
  }

  await ensureDirectory(options.cacheRoot);

  await withStagingDirectory(
    { parent: options.cacheRoot, prefix: `${options.releaseId}.staging` },
    async (staging) => {
      const contentDir = path.join(staging, "content");
      await ensureDirectory(contentDir);

      let completed = 0;
      await mapWithConcurrency(
        manifest.files,
        options.concurrency ?? DEFAULT_CONCURRENCY,
        async (file) => {
          const bytes = await fetchVerifiedContentObject(
            options.storage,
            manifest,
            file,
          );

          const destination = resolveWithin(
            contentDir,
            file.path,
            "Release content path",
          );
          await writeFileAtomic(destination, bytes);

          completed += 1;
          options.onProgress?.(completed, manifest.files.length);
        },
      );

      // The manifest is written last inside the staging directory, so its
      // presence marks the directory as complete.
      await writeFileAtomic(
        path.join(staging, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      const target = path.join(options.cacheRoot, manifest.releaseId);
      assertSafeRelativePath(
        path.relative(options.cacheRoot, target).replace(/\\/gu, "/"),
        "Cache directory",
      );

      /*
       * The previous cache directory is *not* removed here. `readVerifiedCache`
       * already ran and rejected whatever is in the way, so what is left is a
       * partial or stale entry — and deleting it first would throw away the
       * only copy of a release that could still be read if the swap below
       * fails. `replaceDirectoryAtomically` moves it aside, renames the staging
       * directory into place, and puts the old one back when the rename fails,
       * which is the rollback `fs-util.ts` documents.
       */
      await replaceDirectoryAtomically({
        staging,
        target,
        root: options.cacheRoot,
        label: `Release cache ${manifest.releaseId}`,
      });
    },
  );

  const totalBytes = manifest.files.reduce(
    (total, file) => total + file.bytes,
    0,
  );
  const paths = releaseCachePaths(options.cacheRoot, manifest.releaseId);

  return {
    manifest,
    directory: paths.directory,
    contentDir: paths.contentDir,
    fromCache: false,
    fileCount: manifest.files.length,
    bytes: totalBytes,
  };
}

export interface MaterializeOptions {
  /** Directory holding the release's content, or a workspace's content. */
  readonly sourceContentDir: string;
  /** `.ani-content/runtime`. The directory that is replaced. */
  readonly runtimeDir: string;
  /** `.ani-content`. Everything temporary stays inside it. */
  readonly root: string;
  readonly mode: SourceRecord["mode"];
  readonly releaseId?: string | null;
  readonly contentDigest?: string | null;
  readonly instant: Date;
  /** Verified media files and their index, committed with content in one swap. */
  readonly media?: {
    readonly sourceDir: string | null;
    readonly index: MediaIndex;
  };
  readonly offline?: boolean;
}

/**
 * Replace `.ani-content/runtime` with a validated source.
 *
 * A staging directory is built next to the target, its content is verified to
 * be exactly the source, and then the two are swapped. If anything fails, the
 * previous runtime is still in place.
 */
export async function materializeRuntime(options: MaterializeOptions): Promise<{
  readonly source: SourceRecord;
  readonly fileCount: number;
  readonly bytes: number;
  readonly mediaFileCount: number;
  readonly mediaBytes: number;
}> {
  const parent = path.dirname(options.runtimeDir);
  await ensureDirectory(parent);

  const summary = await withStagingDirectory(
    { parent, prefix: `${path.basename(options.runtimeDir)}.staging` },
    async (staging) => {
      const targetContent = path.join(staging, "content");
      const targetMedia = path.join(staging, "media");
      await ensureDirectory(targetContent);
      await ensureDirectory(targetMedia);

      let fileCount = 0;
      let bytes = 0;
      let mediaFileCount = 0;
      let mediaBytes = 0;

      if (options.mode !== "empty") {
        const entries = await listFilesRecursive(options.sourceContentDir);
        const relativePaths = sortByCodePoints(
          entries.map((entry) => entry.relativePath),
        );
        assertNoCaseCollisions(relativePaths, "Materialised content");

        for (const entry of entries) {
          assertSafeRelativePath(entry.relativePath, "Content path");
          bytes += entry.bytes;
        }

        // The source root travels with the list so the copy re-derives each
        // path from the string that was validated, and the per-file limit is
        // enforced here as it is on the download path.
        await copyFileEntries(targetContent, entries, {
          sourceRoot: options.sourceContentDir,
          maxBytes: CONTENT_LIMITS.contentFileBytes,
        });
        fileCount = entries.length;
      }

      const mediaIndex = options.media?.index ?? {
        schemaVersion: 1 as const,
        assets: [],
      };
      const sourceMediaDir = options.media?.sourceDir ?? null;
      if (mediaIndex.assets.length > 0 && sourceMediaDir === null) {
        throw new ValidationError(
          "The media index contains assets, but no verified media directory was supplied.",
        );
      }

      if (sourceMediaDir !== null) {
        const mediaEntries = await listFilesRecursive(sourceMediaDir);
        const mediaPaths = sortByCodePoints(
          mediaEntries.map((entry) => entry.relativePath),
        );
        assertNoCaseCollisions(mediaPaths, "Materialised media");
        for (const entry of mediaEntries) {
          assertSafeRelativePath(entry.relativePath, "Media path");
          mediaBytes += entry.bytes;
        }
        await copyFileEntries(targetMedia, mediaEntries, {
          sourceRoot: sourceMediaDir,
          maxBytes: FILE_MAX_BYTES,
        });
        mediaFileCount = mediaEntries.length;

        const available = new Set(mediaPaths);
        for (const asset of mediaIndex.assets) {
          const localPath = asset.localPath.replace(/^media\//u, "");
          assertSafeRelativePath(localPath, "Media index localPath");
          if (
            !asset.localPath.startsWith("media/") ||
            !available.has(localPath)
          ) {
            throw new ValidationError(
              `Media index localPath ${JSON.stringify(asset.localPath)} is not present in the verified media directory.`,
            );
          }
        }
      }

      await writeJsonFile(path.join(staging, "media-index.json"), mediaIndex);

      const source: SourceRecord = {
        schemaVersion: 1,
        mode: options.mode,
        releaseId: options.releaseId ?? null,
        contentDigest: options.contentDigest ?? null,
        materializedAt: options.instant.toISOString(),
        ...(options.offline === true ? { offline: true } : {}),
      };

      await writeJsonFile(path.join(staging, SOURCE_FILE_NAME), source);

      await replaceDirectoryAtomically({
        staging,
        target: options.runtimeDir,
        root: options.root,
        label: "Content runtime",
      });

      return { source, fileCount, bytes, mediaFileCount, mediaBytes };
    },
  );

  return summary;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
