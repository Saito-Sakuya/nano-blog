import { createHash } from "node:crypto";

import sharp from "sharp";

import type { MediaDerivative } from "./index.js";

/**
 * Turn one source image into the content-addressed derivative set the site
 * serves.
 *
 * The same code path is used for fixture media and for author media, so the
 * build exercises the real pipeline rather than a simplified stand-in. Sharp
 * strips metadata on read by default, which is what makes `media:add`'s
 * privacy guarantee true for anything that flows through here.
 */

/** Widths every image is offered at, from smallest to largest. */
export const DERIVATIVE_WIDTHS = [480, 800, 1200, 1600] as const;

export type DerivativeFormat = "avif" | "webp";

export interface DerivedAsset {
  readonly sourceSha256: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly derivatives: readonly MediaDerivative[];
  /** Files to write, keyed by the path relative to the media root. */
  readonly files: readonly { relativePath: string; data: Buffer }[];
}

/**
 * Widths that make sense for this image. Never upscale: offering a 1600px
 * variant of an 800px original would only waste bandwidth and soften the
 * result.
 */
export function widthsFor(sourceWidth: number): number[] {
  const widths = DERIVATIVE_WIDTHS.filter((width) => width <= sourceWidth);
  return widths.length > 0 ? [...widths] : [sourceWidth];
}

export interface ProcessOptions {
  /** The original file's bytes. */
  readonly source: Buffer;
  /** Original file name, used only to report unsupported input. */
  readonly sourceName: string;
  /** Digest of the original file; the caller usually already has it. */
  readonly sourceSha256: string;
  /** `alt` text is recorded by the caller; this is the licence, if any. */
  readonly license?: string | undefined;
}

export async function deriveAsset(
  options: ProcessOptions,
): Promise<DerivedAsset> {
  const { source, sourceSha256 } = options;

  const image = sharp(source, { failOn: "error" });
  const metadata = await image.metadata();

  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined) {
    throw new Error(`${options.sourceName} has no readable dimensions.`);
  }

  const mime =
    metadata.format === undefined ? "image/png" : `image/${metadata.format}`;
  const extension =
    metadata.format === "jpeg" ? "jpg" : (metadata.format ?? "png");

  const files: { relativePath: string; data: Buffer }[] = [];
  const derivatives: MediaDerivative[] = [];

  for (const targetWidth of widthsFor(width)) {
    const targetHeight = Math.max(
      1,
      Math.round((height / width) * targetWidth),
    );

    for (const format of [
      "avif",
      "webp",
    ] as const satisfies readonly DerivativeFormat[]) {
      // Metadata is dropped explicitly as well as by sharp's default, so the
      // guarantee does not depend on a library default staying put.
      const pipeline = sharp(source)
        .rotate()
        .resize(targetWidth, targetHeight, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .withMetadata({ orientation: undefined });

      const data =
        format === "avif"
          ? await pipeline.avif({ quality: 55, effort: 4 }).toBuffer()
          : await pipeline.webp({ quality: 78 }).toBuffer();

      const relativePath = `${sourceSha256}/${targetWidth}.${format}`;
      files.push({ relativePath, data });
      derivatives.push({
        width: targetWidth,
        format,
        path: `/media/${relativePath}`,
        bytes: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
  }

  // Always keep an original-format fallback, so a browser with neither AVIF
  // nor WebP still gets the image.
  const originalRelative = `${sourceSha256}/original.${extension}`;
  files.push({ relativePath: originalRelative, data: source });
  derivatives.push({
    width,
    format: "original",
    path: `/media/${originalRelative}`,
    bytes: source.byteLength,
    sha256: sourceSha256,
  });

  return {
    sourceSha256,
    mime,
    width,
    height,
    bytes: source.byteLength,
    derivatives,
    files,
  };
}
