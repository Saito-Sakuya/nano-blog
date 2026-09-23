import { ValidationError } from "../lib/errors.js";
import { readBytes } from "../lib/fs-util.js";
import { sha256Hex } from "../release/digest.js";
import { assertAlt, assertCredit, assertOptionalNote } from "./alt.js";
import {
  COVER_VARIANT_HEIGHT,
  COVER_VARIANT_WIDTH,
  mediaPublicPath,
  mediaObjectKey,
  variantPath,
  type CoverReference,
  type MediaMeta,
  type MediaVariant,
} from "./meta.js";
import type { ImageProcessor, ImageStats } from "./processor.js";
import { assertAllowedFile, type DetectedType } from "./signature.js";

/**
 * The media upload plan.
 *
 * A plan is everything that would be written, computed from the source file and
 * nothing else. It is produced identically for a dry run and for `--apply`, so
 * what the author approves is exactly what gets uploaded.
 *
 * Two rules shape it:
 *
 * - **Only sizes the source can actually fill are generated.** A 900-pixel-wide
 *   photograph gets no 1600-pixel variant; upscaling would publish a blurry
 *   file under a name that claims it is large.
 * - **At least one WebP always exists**, together with the sanitised original,
 *   so a reader whose browser cannot decode AVIF still gets a modern format and
 *   a fallback that is guaranteed to work.
 */

export const VARIANT_WIDTHS = [480, 800, 1200, 1600] as const;
export const COVER_MIN_WIDTH = 1600;
export const COVER_MIN_HEIGHT = 900;

/**
 * A flat or placeholder image — a single-colour rectangle, a solid background
 * with a label — makes a useless cover. These thresholds are generous: a real
 * photograph has thousands of colours and a standard deviation well above 10.
 */
export const FLAT_MAX_UNIQUE_COLOURS = 24;
export const FLAT_MIN_STDEV = 3;
export const FLAT_MAX_ENTROPY = 1.5;

/** The widths that are ≤ the source width; never an empty list. */
export function variantWidthsFor(originalWidth: number): number[] {
  const widths = VARIANT_WIDTHS.filter((width) => width <= originalWidth);
  if (widths.length > 0) return [...widths];
  // A source narrower than every step still gets one derivative, so the rule
  // "always keep at least one WebP" holds for tiny images too.
  return [originalWidth];
}

export function assertUsableAsCover(metadata: {
  width: number;
  height: number;
}): void {
  if (metadata.width < COVER_MIN_WIDTH || metadata.height < COVER_MIN_HEIGHT) {
    throw new ValidationError(
      `A cover source must be at least ${COVER_MIN_WIDTH}×${COVER_MIN_HEIGHT}, but this image is ${metadata.width}×${metadata.height}.`,
    );
  }
}

export function assertNotPlaceholder(stats: ImageStats): void {
  if (stats.uniqueColours <= 1) {
    throw new ValidationError(
      "This image is a single flat colour and cannot be a cover. Use a real photograph or illustration.",
    );
  }
  if (
    stats.uniqueColours <= FLAT_MAX_UNIQUE_COLOURS &&
    stats.stdev.every((value) => value < FLAT_MIN_STDEV)
  ) {
    throw new ValidationError(
      `This image is nearly flat (${stats.uniqueColours} distinct colours, standard deviation below ${FLAT_MIN_STDEV}) and is not usable as a cover.`,
    );
  }
  if (stats.entropy < FLAT_MAX_ENTROPY) {
    throw new ValidationError(
      `This image carries almost no visual information (entropy ${stats.entropy.toFixed(2)} bits) and is not usable as a cover.`,
    );
  }
}

export type MediaEntryRole = "variant" | "original" | "meta";

/**
 * Serialise the media record exactly as it is written to disk and uploaded.
 *
 * One function for both destinations, so the bytes in the workspace and the
 * bytes in the bucket are identical by construction rather than by two copies
 * of the same `JSON.stringify` call staying in step.
 */
export function serializeMediaMeta(meta: MediaMeta): Uint8Array {
  return Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export interface MediaPlanEntry {
  /** Bucket key, e.g. `media/<sha>/1600.webp`. */
  readonly key: string;
  /** Public path, e.g. `/media/<sha>/1600.webp`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly role: MediaEntryRole;
  readonly width?: number;
  readonly height?: number;
}

export interface MediaPlan {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly detected: DetectedType;
  readonly meta: MediaMeta;
  readonly entries: readonly MediaPlanEntry[];
  /** The bytes of every entry, keyed by bucket key, ready to write or upload. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  readonly totalBytes: number;
  readonly isCover: boolean;
  readonly cover: CoverReference | null;
  readonly markdown: string;
  readonly warnings: readonly string[];
}

export interface PlanMediaOptions {
  readonly filePath: string;
  readonly alt: string;
  readonly cover: boolean;
  readonly images: ImageProcessor;
  readonly now: Date;
  readonly mediaOrigin: string;
  readonly credit?: string;
  readonly source?: string;
  /** Pre-read bytes; tests use this instead of touching the filesystem. */
  readonly bytes?: Uint8Array;
}

function contentTypeForFormat(format: string): string {
  switch (format) {
    case "avif":
      return "image/avif";
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

export async function planMedia(options: PlanMediaOptions): Promise<MediaPlan> {
  const sourceBytes = options.bytes ?? (await readBytes(options.filePath));
  const detected = assertAllowedFile(sourceBytes, options.filePath);
  const sourceSha256 = sha256Hex(sourceBytes);

  const alt = assertAlt(options.alt);
  const credit =
    options.credit === undefined ? undefined : assertCredit(options.credit);
  const source =
    options.source === undefined
      ? undefined
      : assertOptionalNote(options.source, "Source", 200);

  const warnings: string[] = [];
  const variants: MediaVariant[] = [];
  const variantPayloads = new Map<string, Uint8Array>();
  let originalBytes = sourceBytes;
  let originalSha256 = sourceSha256;
  let originalWidth: number | null = null;
  let originalHeight: number | null = null;
  let originalFormat = detected.extension;

  if (detected.derivable) {
    originalBytes = await options.images.sanitize(sourceBytes);
    originalSha256 = sha256Hex(originalBytes);
    originalFormat = detected.extension;

    const metadata = await options.images.metadata(originalBytes);
    originalWidth = metadata.width;
    originalHeight = metadata.height;

    if (options.cover) {
      assertUsableAsCover(metadata);
      assertNotPlaceholder(await options.images.stats(originalBytes));
    } else if (
      metadata.width >= COVER_MIN_WIDTH &&
      metadata.height >= COVER_MIN_HEIGHT
    ) {
      warnings.push(
        "This image is large enough to be a cover; pass --cover to also generate the 16:9 1600×900 variant.",
      );
    }

    for (const width of variantWidthsFor(metadata.width)) {
      for (const format of ["avif", "webp"] as const) {
        const derived = await options.images.derive(originalBytes, {
          width,
          format,
          crop: options.cover,
        });
        const path = variantPath(sourceSha256, width, format);
        variants.push({
          path,
          width: derived.width,
          height: derived.height,
          bytes: derived.bytes.byteLength,
          sha256: sha256Hex(derived.bytes),
          format,
        });
        variantPayloads.set(mediaObjectKey(path), derived.bytes);
      }
    }
  } else if (options.cover) {
    throw new ValidationError(
      `${options.filePath} is ${detected.label}; only images can be used as a cover.`,
    );
  }

  const hasWebp = variants.some((variant) => variant.format === "webp");
  if (detected.derivable && !hasWebp) {
    // Unreachable while `variantWidthsFor` always returns at least one width,
    // but the guarantee is a rule, so it is asserted rather than assumed.
    throw new ValidationError(
      "No WebP derivative was produced; every image keeps at least one.",
    );
  }

  const meta: MediaMeta = {
    schemaVersion: 1,
    sourceSha256,
    mimeType: detected.mimeType,
    kind: detected.kind,
    alt,
    ...(credit === undefined ? {} : { credit }),
    ...(source === undefined ? {} : { source }),
    license: "CC-BY-4.0",
    original: {
      path: mediaPublicPath(sourceSha256, `original.${originalFormat}`),
      width: originalWidth,
      height: originalHeight,
      bytes: originalBytes.byteLength,
      sha256: originalSha256,
      format: originalFormat,
    },
    variants,
    createdAt: options.now.toISOString(),
  };

  const metaBytes = serializeMediaMeta(meta);
  const metaPath = mediaPublicPath(sourceSha256, "meta.json");

  const entries: MediaPlanEntry[] = [
    ...variants.map((variant) => ({
      key: mediaObjectKey(variant.path),
      path: variant.path,
      bytes: variant.bytes,
      sha256: variant.sha256,
      contentType: contentTypeForFormat(variant.format),
      role: "variant" as const,
      width: variant.width,
      height: variant.height,
    })),
    {
      key: mediaObjectKey(meta.original.path),
      path: meta.original.path,
      bytes: meta.original.bytes,
      sha256: meta.original.sha256,
      contentType: detected.mimeType,
      role: "original" as const,
      ...(originalWidth === null ? {} : { width: originalWidth }),
      ...(originalHeight === null ? {} : { height: originalHeight }),
    },
    {
      key: mediaObjectKey(metaPath),
      path: metaPath,
      bytes: metaBytes.byteLength,
      sha256: sha256Hex(metaBytes),
      contentType: "application/json; charset=utf-8",
      role: "meta" as const,
    },
  ];

  const coverVariant = variants.find(
    (variant) =>
      variant.width === COVER_VARIANT_WIDTH && variant.format === "webp",
  );

  const cover: CoverReference | null =
    coverVariant !== undefined && coverVariant.height === COVER_VARIANT_HEIGHT
      ? {
          src: coverVariant.path,
          alt,
          width: COVER_VARIANT_WIDTH,
          height: COVER_VARIANT_HEIGHT,
          ...(credit === undefined ? {} : { credit }),
        }
      : null;

  const origin = options.mediaOrigin.replace(/\/+$/u, "");
  const markdownVariant =
    variants.find(
      (variant) => variant.width === 1200 && variant.format === "webp",
    ) ??
    [...variants]
      .filter((variant) => variant.format === "webp")
      .sort((a, b) => b.width - a.width)[0];
  const markdownSrc = markdownVariant?.path ?? meta.original.path;

  if (cover === null && options.cover) {
    throw new ValidationError(
      "The 16:9 cover variant was not produced at 1600×900; refusing to report a cover that does not exist.",
    );
  }

  const payloads = new Map<string, Uint8Array>(variantPayloads);
  payloads.set(mediaObjectKey(meta.original.path), originalBytes);
  payloads.set(mediaObjectKey(metaPath), metaBytes);

  return {
    sourcePath: options.filePath,
    sourceSha256,
    detected,
    meta,
    entries,
    payloads,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    isCover: cover !== null,
    cover,
    markdown: `![${alt}](${origin}${markdownSrc})`,
    warnings,
  };
}
