import path from "node:path";
import { stat } from "node:fs/promises";

import type {
  MediaAsset,
  MediaDerivative,
  MediaIndex,
} from "../../src/lib/media/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency.js";
import { ValidationError } from "../lib/errors.js";
import {
  ensureDirectory,
  listFilesRecursive,
  pathExists,
  readBytes,
  replaceDirectoryAtomically,
  withStagingDirectory,
  writeFileAtomic,
} from "../lib/fs-util.js";
import {
  assertNoCaseCollisions,
  resolveWithin,
  sortPaths,
} from "../lib/safe-paths.js";
import {
  mediaObjectKey,
  parseMediaMeta,
  type MediaMeta,
  type MediaOriginal,
  type MediaVariant,
} from "../media/meta.js";
import { FILE_MAX_BYTES } from "../media/signature.js";
import { sha256Hex } from "./digest.js";
import type { ManifestMedia, ReleaseManifest } from "./manifest.js";
import type { StorageAdapter } from "./storage.js";

/** A media record is normally only a few kilobytes. Keep remote JSON bounded. */
export const MEDIA_META_MAX_BYTES = 256 * 1024;

/**
 * Resource ceilings for a Pages build.
 *
 * The media producer currently emits at most eight responsive variants, one
 * original and one meta.json per asset. The per-asset limit therefore admits
 * every supported image family exactly, without leaving room for an unbounded
 * variant list in damaged metadata. A self-hosted blog should not need more
 * than 256 distinct assets or 512 MiB of media to render one immutable release;
 * larger releases must be split or deliberately raise these reviewed limits.
 */
export const MAX_MEDIA_FILES_PER_ASSET = 10;
export const MAX_MEDIA_ASSETS_PER_RELEASE = 256;
export const MAX_MEDIA_BYTES_PER_RELEASE = 512 * 1024 * 1024;

const MEDIA_CACHE_DIRECTORY = "media";

interface MediaFileDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface PreparedMediaAsset {
  readonly digest: string;
  readonly meta: MediaMeta;
  readonly metaBytes: Uint8Array;
  readonly metaRelativePath: string;
  readonly descriptors: readonly MediaFileDescriptor[];
  readonly asset: MediaAsset;
}

class MediaResourceLimitError extends ValidationError {
  override readonly name = "MediaResourceLimitError";
}

export interface ReleaseMediaBundle {
  /** Directory containing paths relative to `/media/`, or null for no media. */
  readonly directory: string | null;
  readonly index: MediaIndex;
  readonly fileCount: number;
  readonly bytes: number;
  readonly fromCache: boolean;
}

export interface PullReleaseMediaOptions {
  readonly manifest: ReleaseManifest;
  readonly cacheDirectory: string;
  readonly storage?: StorageAdapter;
  readonly offline?: boolean;
  readonly concurrency?: number;
}

function digestFromReference(reference: ManifestMedia): string {
  const digest = reference.path.split("/")[2];
  if (digest === undefined || digest !== reference.sha256) {
    throw new ValidationError(
      `Media reference ${reference.path} does not agree with its source digest ${reference.sha256}.`,
    );
  }
  return digest;
}

function referencesByDigest(
  manifest: ReleaseManifest,
): ReadonlyMap<string, readonly ManifestMedia[]> {
  const maxReferences =
    MAX_MEDIA_ASSETS_PER_RELEASE * (MAX_MEDIA_FILES_PER_ASSET - 1);
  if (manifest.media.length > maxReferences) {
    throw new MediaResourceLimitError(
      `Release ${manifest.releaseId} declares ${manifest.media.length} media references; at most ${maxReferences} references can fit within ${MAX_MEDIA_ASSETS_PER_RELEASE} assets of ${MAX_MEDIA_FILES_PER_ASSET} files each.`,
    );
  }

  const grouped = new Map<string, ManifestMedia[]>();
  for (const reference of manifest.media) {
    const digest = digestFromReference(reference);
    const current = grouped.get(digest) ?? [];
    if (current.length === 0 && grouped.size >= MAX_MEDIA_ASSETS_PER_RELEASE) {
      throw new MediaResourceLimitError(
        `Release ${manifest.releaseId} references more than ${MAX_MEDIA_ASSETS_PER_RELEASE} distinct media assets.`,
      );
    }
    current.push(reference);
    grouped.set(digest, current);
  }
  return grouped;
}

function fileDescriptors(meta: MediaMeta): MediaFileDescriptor[] {
  return [meta.original, ...meta.variants]
    .map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function assertVariantPath(
  digest: string,
  variant: MediaVariant,
  label: string,
): void {
  const match = new RegExp(
    `^/media/${digest}/([0-9]+)\\.(avif|webp)$`,
    "u",
  ).exec(variant.path);
  if (
    match === null ||
    Number(match[1]) !== variant.width ||
    match[2] !== variant.format
  ) {
    throw new ValidationError(
      `${label}: ${variant.path} does not agree with its declared ${variant.width}px ${variant.format} variant.`,
    );
  }
}

function assertOriginalPath(
  digest: string,
  original: MediaOriginal,
  label: string,
): void {
  if (original.path !== `/media/${digest}/original.${original.format}`) {
    throw new ValidationError(
      `${label}: ${original.path} does not agree with its declared original format ${original.format}.`,
    );
  }
}

/**
 * Validate invariants that are deliberately stronger than the JSON schema.
 *
 * `meta.json` is remote input. Its paths become local paths and its dimensions
 * become HTML attributes, so a structurally valid but internally inconsistent
 * record must never reach the runtime.
 */
function validateMediaMeta(
  meta: MediaMeta,
  digest: string,
  references: readonly ManifestMedia[],
  label: string,
): readonly MediaFileDescriptor[] {
  if (meta.sourceSha256 !== digest) {
    throw new ValidationError(
      `${label} describes source ${meta.sourceSha256}, but the release references ${digest}.`,
    );
  }

  assertOriginalPath(digest, meta.original, label);
  for (const variant of meta.variants) {
    assertVariantPath(digest, variant, label);
  }

  if (meta.kind === "image") {
    if (meta.original.width === null || meta.original.height === null) {
      throw new ValidationError(
        `${label}: an image original must declare both width and height.`,
      );
    }
  } else if (meta.variants.length > 0) {
    throw new ValidationError(
      `${label}: only image media may declare responsive variants.`,
    );
  }

  const descriptors = fileDescriptors(meta);
  const assetFileCount = descriptors.length + 1; // meta.json travels with data.
  if (assetFileCount > MAX_MEDIA_FILES_PER_ASSET) {
    throw new MediaResourceLimitError(
      `${label} describes ${assetFileCount} files including meta.json; one media asset may contain at most ${MAX_MEDIA_FILES_PER_ASSET}.`,
    );
  }
  const paths = descriptors.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new ValidationError(`${label} declares the same media path twice.`);
  }
  assertNoCaseCollisions(paths, label);

  for (const entry of descriptors) {
    if (entry.bytes > FILE_MAX_BYTES) {
      throw new ValidationError(
        `${label}: ${entry.path} declares ${entry.bytes} bytes, above the ${FILE_MAX_BYTES}-byte media limit.`,
      );
    }
  }

  const known = new Set(paths);
  for (const reference of references) {
    if (!known.has(reference.path)) {
      throw new ValidationError(
        `${label}: release media reference ${reference.path} is not the original or a variant recorded for ${digest}.`,
      );
    }
  }

  return descriptors;
}

function assertReleaseByteBudget(
  assets: readonly PreparedMediaAsset[],
): number {
  let total = 0;
  for (const prepared of assets) {
    for (const bytes of [
      prepared.metaBytes.byteLength,
      ...prepared.descriptors.map((entry) => entry.bytes),
    ]) {
      total += bytes;
      if (total > MAX_MEDIA_BYTES_PER_RELEASE) {
        throw new MediaResourceLimitError(
          `Release media declares ${total} bytes, above the ${MAX_MEDIA_BYTES_PER_RELEASE}-byte (${MAX_MEDIA_BYTES_PER_RELEASE / (1024 * 1024)} MiB) build limit.`,
        );
      }
    }
  }
  return total;
}

function localRelativePath(publicPath: string): string {
  const prefix = "/media/";
  if (!publicPath.startsWith(prefix)) {
    throw new ValidationError(
      `Media path ${publicPath} does not start with ${prefix}.`,
    );
  }
  return publicPath.slice(prefix.length);
}

function derivativeFormat(format: string): "avif" | "webp" {
  if (format === "avif" || format === "webp") return format;
  throw new ValidationError(
    `Responsive media format must be avif or webp, but received ${JSON.stringify(format)}.`,
  );
}

function assetFromMeta(meta: MediaMeta): MediaAsset {
  const local = [...meta.variants]
    .filter((variant) => variant.format === "webp")
    .sort((a, b) => b.width - a.width)[0];
  const localPath = local?.path ?? meta.original.path;

  const derivatives: MediaDerivative[] = [
    ...meta.variants.map((variant) => ({
      width: variant.width,
      format: derivativeFormat(variant.format),
      path: variant.path,
      bytes: variant.bytes,
      sha256: variant.sha256,
    })),
    {
      // Non-image originals still belong in the index (AudioPlayer uses it).
      // Width is irrelevant for the `original` format, while image assets keep
      // their real intrinsic width.
      width: meta.original.width ?? 0,
      format: "original",
      path: meta.original.path,
      bytes: meta.original.bytes,
      sha256: meta.original.sha256,
    },
  ];

  return {
    sourceSha256: meta.sourceSha256,
    kind: meta.kind,
    mime: meta.mimeType,
    alt: meta.alt,
    width: meta.original.width,
    height: meta.original.height,
    bytes: meta.original.bytes,
    ...(meta.credit === undefined ? {} : { credit: meta.credit }),
    license: meta.license,
    localPath: path.posix.join("media", localRelativePath(localPath)),
    derivatives,
  };
}

function parseMediaMetaBytes(bytes: Uint8Array, label: string): MediaMeta {
  if (bytes.byteLength > MEDIA_META_MAX_BYTES) {
    throw new MediaResourceLimitError(
      `${label} is ${bytes.byteLength} bytes, above the ${MEDIA_META_MAX_BYTES}-byte media metadata limit.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new ValidationError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseMediaMeta(value, label);
}

function prepareMediaAsset(
  digest: string,
  references: readonly ManifestMedia[],
  metaBytes: Uint8Array,
  label: string,
): PreparedMediaAsset {
  const meta = parseMediaMetaBytes(metaBytes, label);
  const descriptors = validateMediaMeta(meta, digest, references, label);
  return {
    digest,
    meta,
    metaBytes,
    metaRelativePath: `${digest}/meta.json`,
    descriptors,
    asset: assetFromMeta(meta),
  };
}

async function readCachedMeta(
  directory: string,
  digest: string,
): Promise<Uint8Array> {
  const relative = `${digest}/meta.json`;
  const file = resolveWithin(directory, relative, "Cached media record");
  const info = await stat(file);
  if (!info.isFile()) {
    throw new ValidationError(`${file} is not a regular media metadata file.`);
  }
  if (info.size > MEDIA_META_MAX_BYTES) {
    throw new MediaResourceLimitError(
      `${file} is ${info.size} bytes, above the ${MEDIA_META_MAX_BYTES}-byte media metadata limit.`,
    );
  }
  return readBytes(file);
}

async function verifiedFile(
  root: string,
  descriptor: MediaFileDescriptor,
): Promise<number> {
  const relative = localRelativePath(descriptor.path);
  const file = resolveWithin(root, relative, "Cached media path");
  const data = await readBytes(file);
  if (data.byteLength !== descriptor.bytes) {
    throw new ValidationError(
      `${descriptor.path} is ${data.byteLength} bytes in the media cache, but meta.json declares ${descriptor.bytes}.`,
    );
  }
  const actual = sha256Hex(data);
  if (actual !== descriptor.sha256) {
    throw new ValidationError(
      `${descriptor.path} hashes to ${actual} in the media cache, but meta.json declares ${descriptor.sha256}.`,
    );
  }
  return data.byteLength;
}

async function inspectMediaDirectory(
  directory: string,
  manifest: ReleaseManifest,
): Promise<Omit<ReleaseMediaBundle, "directory" | "fromCache">> {
  const grouped = referencesByDigest(manifest);
  const prepared = await mapWithConcurrency(
    [...grouped.entries()],
    DEFAULT_CONCURRENCY,
    async ([digest, references]) => {
      const metaRelativePath = `${digest}/meta.json`;
      const metaPath = resolveWithin(
        directory,
        metaRelativePath,
        "Cached media record",
      );
      return prepareMediaAsset(
        digest,
        references,
        await readCachedMeta(directory, digest),
        metaPath,
      );
    },
  );

  const declaredBytes = assertReleaseByteBudget(prepared);
  await mapWithConcurrency(prepared, DEFAULT_CONCURRENCY, async (entry) => {
    for (const descriptor of entry.descriptors) {
      await verifiedFile(directory, descriptor);
    }
  });

  const expectedPaths = prepared.flatMap((entry) => [
    entry.metaRelativePath,
    ...entry.descriptors.map((descriptor) =>
      localRelativePath(descriptor.path),
    ),
  ]);

  const actualPaths = sortPaths(
    (await listFilesRecursive(directory)).map((entry) => entry.relativePath),
  );
  const expected = sortPaths(expectedPaths);
  if (
    actualPaths.length !== expected.length ||
    actualPaths.some((entry, index) => entry !== expected[index])
  ) {
    throw new ValidationError(
      `The media cache does not contain exactly the objects described by the release media records. Expected ${expected.length} file(s), found ${actualPaths.length}.`,
    );
  }

  const index: MediaIndex = {
    schemaVersion: 1,
    assets: prepared
      .map((entry) => entry.asset)
      .sort((a, b) =>
        a.sourceSha256 < b.sourceSha256
          ? -1
          : a.sourceSha256 > b.sourceSha256
            ? 1
            : 0,
      ),
  };

  return {
    index,
    fileCount: actualPaths.length,
    bytes: declaredBytes,
  };
}

export async function readVerifiedMediaCache(
  cacheDirectory: string,
  manifest: ReleaseManifest,
): Promise<ReleaseMediaBundle | null> {
  if (manifest.media.length === 0) {
    return {
      directory: null,
      index: { schemaVersion: 1, assets: [] },
      fileCount: 0,
      bytes: 0,
      fromCache: true,
    };
  }

  const directory = path.join(cacheDirectory, MEDIA_CACHE_DIRECTORY);
  if (!(await pathExists(directory))) return null;

  try {
    const inspected = await inspectMediaDirectory(directory, manifest);
    return { directory, ...inspected, fromCache: true };
  } catch (error) {
    if (error instanceof MediaResourceLimitError) throw error;
    return null;
  }
}

async function readRemoteMeta(
  storage: StorageAdapter,
  digest: string,
): Promise<Uint8Array> {
  const key = `media/${digest}/meta.json`;
  const object = await storage.get(key, { maxBytes: MEDIA_META_MAX_BYTES });
  if (object.bytes.byteLength > MEDIA_META_MAX_BYTES) {
    throw new MediaResourceLimitError(
      `${key} is ${object.bytes.byteLength} bytes, above the ${MEDIA_META_MAX_BYTES}-byte media metadata limit.`,
    );
  }
  return object.bytes;
}

async function downloadDescriptor(
  storage: StorageAdapter,
  staging: string,
  descriptor: MediaFileDescriptor,
): Promise<void> {
  const key = mediaObjectKey(descriptor.path);
  const object = await storage.get(key, { maxBytes: FILE_MAX_BYTES });
  if (object.bytes.byteLength !== descriptor.bytes) {
    throw new ValidationError(
      `${key} is ${object.bytes.byteLength} bytes, but meta.json declares ${descriptor.bytes}.`,
    );
  }
  const actual = sha256Hex(object.bytes);
  if (actual !== descriptor.sha256) {
    throw new ValidationError(
      `${key} hashes to ${actual}, but meta.json declares ${descriptor.sha256}.`,
    );
  }
  const target = resolveWithin(
    staging,
    localRelativePath(descriptor.path),
    "Downloaded media path",
  );
  await writeFileAtomic(target, object.bytes);
}

export async function pullReleaseMedia(
  options: PullReleaseMediaOptions,
): Promise<ReleaseMediaBundle> {
  const grouped = referencesByDigest(options.manifest);
  if (options.offline === true) {
    const cached = await readVerifiedMediaCache(
      options.cacheDirectory,
      options.manifest,
    );
    if (cached !== null) return cached;
    throw new ValidationError(
      `The verified media cache for release ${options.manifest.releaseId} is missing or damaged, and --offline forbids downloading it.`,
    );
  }

  if (grouped.size === 0) {
    return {
      directory: null,
      index: { schemaVersion: 1, assets: [] },
      fileCount: 0,
      bytes: 0,
      fromCache: false,
    };
  }
  if (options.storage === undefined) {
    throw new ValidationError(
      "Media storage is required when the verified media cache is unavailable.",
    );
  }

  const storage = options.storage;
  const prepared = await mapWithConcurrency(
    [...grouped.entries()],
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async ([digest, references]) => {
      const key = `media/${digest}/meta.json`;
      return prepareMediaAsset(
        digest,
        references,
        await readRemoteMeta(storage, digest),
        key,
      );
    },
  );
  assertReleaseByteBudget(prepared);

  await ensureDirectory(options.cacheDirectory);
  const target = path.join(options.cacheDirectory, MEDIA_CACHE_DIRECTORY);

  const inspected = await withStagingDirectory(
    { parent: options.cacheDirectory, prefix: "media.staging" },
    async (staging) => {
      await mapWithConcurrency(
        prepared,
        options.concurrency ?? DEFAULT_CONCURRENCY,
        async (entry) => {
          const metaTarget = resolveWithin(
            staging,
            entry.metaRelativePath,
            "Downloaded media record",
          );
          await writeFileAtomic(metaTarget, entry.metaBytes);
          for (const descriptor of entry.descriptors) {
            await downloadDescriptor(storage, staging, descriptor);
          }
        },
      );

      const result = await inspectMediaDirectory(staging, options.manifest);
      await replaceDirectoryAtomically({
        staging,
        target,
        root: options.cacheDirectory,
        label: `Release media cache ${options.manifest.releaseId}`,
      });
      return result;
    },
  );

  return { directory: target, ...inspected, fromCache: false };
}
