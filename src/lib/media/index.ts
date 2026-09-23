import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { ANI_CONTENT_DIR } from "../content/paths.js";

/**
 * The media index for the current build.
 *
 * Content references media by its content-addressed public path, but a build
 * also needs three things the path alone cannot answer: the intrinsic size (for
 * `width`/`height` and `srcset`), the derivative ladder, and a local file to
 * read when rendering an Open Graph card. All three come from here.
 *
 * The index is produced by the same materialisation step that writes
 * `.ani-content/runtime/content`, so it always describes exactly the media the
 * current content refers to.
 */

export interface MediaDerivative {
  readonly width: number;
  readonly format: "avif" | "webp" | "original";
  /** Public path, e.g. `/media/<sha>/800.webp`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface MediaAsset {
  /** SHA-256 of the original source file. */
  readonly sourceSha256: string;
  readonly kind: "image" | "audio" | "document";
  readonly mime: string;
  readonly alt: string;
  /** Null for media such as audio and documents that has no image intrinsic. */
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number;
  readonly credit?: string | undefined;
  readonly license?: string | undefined;
  /** Path of the local copy, relative to `.ani-content/runtime`. */
  readonly localPath: string;
  readonly derivatives: readonly MediaDerivative[];
}

export interface MediaIndex {
  readonly schemaVersion: 1;
  readonly assets: readonly MediaAsset[];
}

const EMPTY_INDEX: MediaIndex = { schemaVersion: 1, assets: [] };

let cached: MediaIndex | undefined;

export function mediaIndexPath(): string {
  return path.join(ANI_CONTENT_DIR, "runtime", "media-index.json");
}

/**
 * Read the index. A build with no media yet is a legitimate state, not an
 * error, so a missing file yields an empty index.
 */
export function loadMediaIndex(): MediaIndex {
  if (cached !== undefined) return cached;

  const file = mediaIndexPath();
  if (!existsSync(file)) {
    cached = EMPTY_INDEX;
    return cached;
  }

  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  cached = validateIndex(parsed);
  return cached;
}

/** Drop the memoised index. Test-only. */
export function resetMediaIndex(): void {
  cached = undefined;
}

function validateIndex(value: unknown): MediaIndex {
  if (typeof value !== "object" || value === null) {
    throw new Error("media-index.json must contain an object.");
  }
  const record = value as { schemaVersion?: unknown; assets?: unknown };
  if (record.schemaVersion !== 1) {
    throw new Error("media-index.json must declare schemaVersion 1.");
  }
  if (!Array.isArray(record.assets)) {
    throw new Error("media-index.json must contain an assets array.");
  }
  return { schemaVersion: 1, assets: record.assets as MediaAsset[] };
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

/** `/media/<sha>/1600.webp` → the source digest, or `null` if it is not one. */
export function sourceShaFromPublicPath(publicPath: string): string | null {
  const match = /^\/media\/([0-9a-f]{64})\//u.exec(publicPath);
  return match?.[1] ?? null;
}

export function findAsset(
  index: MediaIndex,
  publicPath: string,
): MediaAsset | null {
  const sha = sourceShaFromPublicPath(publicPath);
  if (sha === null) return null;
  return index.assets.find((asset) => asset.sourceSha256 === sha) ?? null;
}

/**
 * The derivative ladder for one asset, largest first, for `srcset`.
 */
export function derivativesFor(
  asset: MediaAsset,
  format: "avif" | "webp" | "original",
): MediaDerivative[] {
  return asset.derivatives
    .filter((derivative) => derivative.format === format)
    .sort((a, b) => b.width - a.width);
}

/** Absolute path of the local copy of an asset. */
export function localAssetPath(asset: MediaAsset): string {
  return path.join(ANI_CONTENT_DIR, "runtime", asset.localPath);
}
