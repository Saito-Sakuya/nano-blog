import path from "node:path";
import { z } from "astro/zod";

import { ValidationError } from "../lib/errors.js";
import { pathExists, readJsonFile, writeJsonFile } from "../lib/fs-util.js";
import { assertSafeRelativePath } from "../lib/safe-paths.js";
import { SHA256_HEX_PATTERN } from "../release/digest.js";
import {
  MEDIA_META_CACHE_CONTROL,
  IMMUTABLE_MEDIA_CACHE_CONTROL,
} from "../release/buckets.js";

/**
 * The media record.
 *
 * One `meta.json` per source, alongside the derivatives it describes, in both
 * the local workspace and the public bucket. It is the document that lets a
 * cover reference be verified: the frontmatter says `/media/<sha>/1600.webp` at
 * 1600×900, and this record is where those numbers can actually be checked
 * rather than believed.
 */

export const MEDIA_SCHEMA_VERSION = 1;
export const MEDIA_PATH_PREFIX = "media/";
export const PUBLIC_MEDIA_PATH_PREFIX = "/media/";
export const COVER_VARIANT_WIDTH = 1600;
export const COVER_VARIANT_HEIGHT = 900;

export interface MediaVariant {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: string;
}

export interface MediaOriginal {
  /** `/media/<sha>/original.<ext>`. */
  readonly path: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: string;
}

export interface MediaMeta {
  readonly schemaVersion: number;
  readonly sourceSha256: string;
  readonly mimeType: string;
  readonly kind: "image" | "audio" | "document";
  readonly alt: string;
  // `| undefined` is explicit because `exactOptionalPropertyTypes` is on: a
  // parsed record and a built record must be assignable to the same type.
  readonly credit?: string | undefined;
  readonly source?: string | undefined;
  readonly license: string;
  readonly original: MediaOriginal;
  readonly variants: readonly MediaVariant[];
  readonly createdAt: string;
}

const variantSchema = z.strictObject({
  path: z
    .string()
    .regex(
      /^\/media\/[0-9a-f]{64}\/[0-9]+\.(avif|webp)$/u,
      "Must be /media/<sha>/<width>.avif or .webp.",
    ),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(SHA256_HEX_PATTERN, "Must be 64 lowercase hex characters."),
  format: z.enum(["avif", "webp"]),
});

const originalSchema = z.strictObject({
  path: z
    .string()
    .regex(
      /^\/media\/[0-9a-f]{64}\/original\.[a-z0-9]+$/u,
      "Must be /media/<sha>/original.<ext>.",
    ),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  bytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(SHA256_HEX_PATTERN, "Must be 64 lowercase hex characters."),
  format: z.string().min(1),
});

export const mediaMetaSchema = z.strictObject({
  schemaVersion: z.literal(MEDIA_SCHEMA_VERSION),
  sourceSha256: z
    .string()
    .regex(SHA256_HEX_PATTERN, "Must be 64 lowercase hex characters."),
  mimeType: z.string().min(1),
  kind: z.enum(["image", "audio", "document"]),
  alt: z.string().min(1),
  credit: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(200).optional(),
  license: z.literal("CC-BY-4.0"),
  original: originalSchema,
  variants: z.array(variantSchema),
  createdAt: z.iso.datetime({ offset: true }),
});

export function parseMediaMeta(value: unknown, label = "meta.json"): MediaMeta {
  const result = mediaMetaSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `${label} does not match the media record schema.`,
      {
        issues: result.error.issues.map(
          (issue) =>
            `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
        ),
      },
    );
  }

  const meta = result.data;
  const issues: string[] = [];

  for (const [index, variant] of meta.variants.entries()) {
    const fromPath = variant.path.split("/")[2] ?? "";
    if (fromPath !== meta.sourceSha256) {
      issues.push(
        `variants[${index}].path (${variant.path}) does not sit under the source digest ${meta.sourceSha256}.`,
      );
    }
  }
  const originalDigest = meta.original.path.split("/")[2] ?? "";
  if (originalDigest !== meta.sourceSha256) {
    issues.push(
      `original.path (${meta.original.path}) does not sit under the source digest.`,
    );
  }

  if (issues.length > 0) {
    throw new ValidationError(`${label} is not a valid media record.`, {
      issues,
    });
  }

  return meta;
}

/** `media/<sha256>` — the bucket prefix and the workspace directory. */
export function mediaAssetDirectory(sourceSha256: string): string {
  return `${MEDIA_PATH_PREFIX}${sourceSha256}`;
}

/** `/media/<sha256>/<file>` — the public URL path. */
export function mediaPublicPath(sourceSha256: string, file: string): string {
  assertSafeRelativePath(file, "Media file name");
  return `${PUBLIC_MEDIA_PATH_PREFIX}${sourceSha256}/${file}`;
}

/** The variant path `/media/<sha>/1600.webp`, from a source digest and width. */
export function variantPath(
  sourceSha256: string,
  width: number,
  format: "avif" | "webp",
): string {
  return mediaPublicPath(sourceSha256, `${width}.${format}`);
}

export function mediaObjectKey(publicPath: string): string {
  return publicPath.startsWith("/") ? publicPath.slice(1) : publicPath;
}

export function cacheControlFor(publicPath: string): string {
  return publicPath.endsWith("/meta.json")
    ? MEDIA_META_CACHE_CONTROL
    : IMMUTABLE_MEDIA_CACHE_CONTROL;
}

export function mediaRecordPath(
  workspaceMediaDir: string,
  sourceSha256: string,
): string {
  return path.join(workspaceMediaDir, sourceSha256, "meta.json");
}

/** Read a local media record, or null when this source has never been added. */
export async function readMediaRecord(
  workspaceMediaDir: string,
  sourceSha256: string,
): Promise<MediaMeta | null> {
  const recordPath = mediaRecordPath(workspaceMediaDir, sourceSha256);
  if (!(await pathExists(recordPath))) return null;
  try {
    return parseMediaMeta(await readJsonFile(recordPath), recordPath);
  } catch {
    return null;
  }
}

export async function writeMediaRecord(
  workspaceMediaDir: string,
  meta: MediaMeta,
): Promise<string> {
  const recordPath = mediaRecordPath(workspaceMediaDir, meta.sourceSha256);
  await writeJsonFile(recordPath, meta);
  return recordPath;
}

export interface CoverReference {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly credit?: string;
}

/**
 * The `cover` object for frontmatter.
 *
 * The 1600×900 WebP is the cover by definition: it is the size the schema
 * requires, so a media record without one cannot produce a cover at all.
 */
export function coverFromMeta(meta: MediaMeta): CoverReference {
  const cover = meta.variants.find(
    (variant) =>
      variant.width === COVER_VARIANT_WIDTH && variant.format === "webp",
  );
  if (cover === undefined) {
    throw new ValidationError(
      `${meta.sourceSha256} has no ${COVER_VARIANT_WIDTH}.webp variant, so it cannot be used as a cover.`,
    );
  }
  if (cover.height !== COVER_VARIANT_HEIGHT) {
    throw new ValidationError(
      `${meta.sourceSha256} has a ${cover.width}×${cover.height} cover variant; a cover must be ${COVER_VARIANT_WIDTH}×${COVER_VARIANT_HEIGHT}.`,
    );
  }

  return {
    src: cover.path,
    alt: meta.alt,
    width: COVER_VARIANT_WIDTH,
    height: COVER_VARIANT_HEIGHT,
    ...(meta.credit === undefined ? {} : { credit: meta.credit }),
  };
}

/** A standard Markdown image, with the media origin applied. */
export function markdownImage(
  meta: MediaMeta,
  origin: string,
  width = COVER_VARIANT_WIDTH,
): string {
  const variant =
    meta.variants.find(
      (entry) => entry.width === width && entry.format === "webp",
    ) ??
    [...meta.variants]
      .filter((entry) => entry.format === "webp")
      .sort((a, b) => b.width - a.width)[0];

  const src = variant?.path ?? meta.original.path;

  return `![${meta.alt}](${origin.replace(/\/+$/u, "")}${src})`;
}
