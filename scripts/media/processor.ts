import sharp from "sharp";

import { ValidationError } from "../lib/errors.js";

/**
 * The image pipeline.
 *
 * It is an interface, not a set of `sharp` calls scattered through the upload
 * command, for two reasons: the derivation rules are worth testing without
 * encoding real images, and the tooling has to keep working in an environment
 * where the native `sharp` binary cannot load for a command that never touches
 * an image.
 *
 * Privacy is the reason `sanitize` exists as a separate step. A photograph
 * straight from a phone carries GPS coordinates, a camera serial number, a
 * capture timestamp and an embedded thumbnail — the thumbnail being a version
 * of the image that was never meant to be published. Nothing here ever calls
 * `withMetadata()`: `sharp` drops all of it unless it is explicitly asked to
 * keep it, and the auto-orientation pass is applied first so the pixels match
 * the orientation the EXIF tag described before that tag disappears.
 */

export type DerivedFormat = "avif" | "webp";

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly hasAlpha: boolean;
}

export interface ImageStats {
  /** Per-channel standard deviation, 0–255. */
  readonly stdev: readonly number[];
  /** Distinct colours in a 32×32 reduction; a flat image has very few. */
  readonly uniqueColours: number;
  /** Shannon entropy of the luminance histogram, in bits. */
  readonly entropy: number;
}

export interface DerivedImage {
  readonly width: number;
  readonly height: number;
  readonly format: DerivedFormat;
  readonly bytes: Uint8Array;
}

export interface DeriveOptions {
  readonly width: number;
  readonly format: DerivedFormat;
  /** Centre-crop to 16:9 instead of preserving the aspect ratio. */
  readonly crop: boolean;
  /** Quality override; defaults are per format. */
  readonly quality?: number;
}

export interface ImageProcessor {
  readonly label: string;
  metadata(bytes: Uint8Array): Promise<ImageMetadata>;
  stats(bytes: Uint8Array): Promise<ImageStats>;
  /** Auto-oriented, metadata-free bytes in the original format. */
  sanitize(bytes: Uint8Array): Promise<Uint8Array>;
  derive(bytes: Uint8Array, options: DeriveOptions): Promise<DerivedImage>;
}

const AVIF_QUALITY = 62;
const WEBP_QUALITY = 82;

function qualityFor(
  format: DerivedFormat,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  return format === "avif" ? AVIF_QUALITY : WEBP_QUALITY;
}

export function createSharpImageProcessor(): ImageProcessor {
  return {
    label: `sharp ${sharp.versions.sharp}`,

    async metadata(bytes) {
      const meta = await sharp(bytes, { failOn: "error" }).metadata();
      if (meta.width === undefined || meta.height === undefined) {
        throw new ValidationError("The image reports no dimensions.");
      }
      return {
        width: meta.width,
        height: meta.height,
        format: meta.format ?? "unknown",
        hasAlpha: meta.hasAlpha === true,
      };
    },

    async stats(bytes) {
      const image = sharp(bytes, { failOn: "error" });
      const [stats, reduced] = await Promise.all([
        image.stats(),
        sharp(bytes, { failOn: "error" })
          .resize(32, 32, { fit: "fill" })
          .removeAlpha()
          .raw()
          .toBuffer(),
      ]);

      const colours = new Set<number>();
      for (let index = 0; index + 2 < reduced.length; index += 3) {
        const red = reduced[index] ?? 0;
        const green = reduced[index + 1] ?? 0;
        const blue = reduced[index + 2] ?? 0;
        colours.add((red << 16) | (green << 8) | blue);
      }

      return {
        stdev: stats.channels.map((channel) => channel.stdev),
        uniqueColours: colours.size,
        entropy: stats.entropy ?? 0,
      };
    },

    async sanitize(bytes) {
      // `rotate()` with no argument applies the EXIF orientation to the pixels
      // and then discards it along with every other metadata field.
      return sharp(bytes, { failOn: "error" }).rotate().toBuffer();
    },

    async derive(bytes, options) {
      const quality = qualityFor(options.format, options.quality);
      const pipeline = sharp(bytes, { failOn: "error" })
        .rotate()
        .resize({
          width: options.width,
          ...(options.crop
            ? {
                height: Math.round((options.width * 9) / 16),
                fit: "cover" as const,
                position: "centre" as const,
              }
            : {}),
          withoutEnlargement: true,
        });

      const encoded =
        options.format === "avif"
          ? await pipeline
              .avif({ quality, effort: 4 })
              .toBuffer({ resolveWithObject: true })
          : await pipeline
              .webp({ quality, effort: 4 })
              .toBuffer({ resolveWithObject: true });

      return {
        width: encoded.info.width,
        height: encoded.info.height,
        format: options.format,
        bytes: encoded.data,
      };
    },
  };
}
