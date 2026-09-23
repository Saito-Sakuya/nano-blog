import type { MediaAsset, MediaDerivative, MediaIndex } from "./index.js";
import { derivativesFor, findAsset } from "./index.js";
import { MEDIA_ORIGIN, MEDIA_PATH_PREFIX } from "../site.js";

/**
 * Responsive `<picture>` data for an image referenced from content.
 *
 * Content stores a media path (`/media/<sha>/1600.webp`); the page needs
 * absolute URLs, a format ladder and a width/height pair so the layout can
 * reserve space before the bytes arrive. Building that here keeps the rule in
 * one place: every content image is served from the media origin, from the
 * content-addressed directory its digest names.
 */

export interface PictureSource {
  readonly type: string;
  readonly srcset: string;
}

export interface PictureData {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly sources: readonly PictureSource[];
  /**
   * The `sizes` value every `<source>` in this picture must carry.
   *
   * Returned rather than left to the caller's markup because the two are one
   * decision: a `srcset` of five widths is only useful if the browser knows how
   * wide the image will be drawn, and the width is a property of the layout the
   * caller is asking about. Written twice — once into the options and once as a
   * literal attribute — they drifted, and the article cover shipped a `sizes`
   * that described a different box from the one the layout reserved.
   */
  readonly sizes: string;
  readonly available: boolean;
  /**
   * The asset's own pixel dimensions, when the media index knows them.
   *
   * A caller that reserves a box should size it from this ratio rather than
   * assuming 16:9: the fixture set happens to be 16:9, which is exactly why a
   * hard-coded ratio would go unnoticed until the first non-16:9 photograph
   * reflowed everything below it once it loaded.
   */
  readonly intrinsic: {
    readonly width: number;
    readonly height: number;
  } | null;
}

/** Absolute public URL for a `/media/...` path. */
export function mediaUrl(publicPath: string): string {
  if (!publicPath.startsWith(MEDIA_PATH_PREFIX)) return publicPath;
  return `${MEDIA_ORIGIN}${publicPath}`;
}

/**
 * Build the picture data for an image.
 *
 * `displayWidth`/`displayHeight` describe the box the image is rendered into,
 * which is what the layout reserves. When the media index has no record the
 * image still renders — at its declared cover size — rather than breaking the
 * build over a missing optimisation record; `content:validate` is what reports
 * that as an error.
 */
export function buildPicture(
  index: MediaIndex,
  publicPath: string,
  options: {
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly sizes: string;
  },
): PictureData {
  const asset: MediaAsset | null = findAsset(index, publicPath);

  if (asset === null) {
    return {
      src: mediaUrl(publicPath),
      width: options.displayWidth,
      height: options.displayHeight,
      sources: [],
      sizes: options.sizes,
      available: false,
      intrinsic: null,
    };
  }

  const sources: PictureSource[] = [];
  for (const format of ["avif", "webp"] as const) {
    const ladder = derivativesFor(asset, format);
    if (ladder.length === 0) continue;
    sources.push({
      type: `image/${format}`,
      srcset: ladder
        .map((entry) => `${mediaUrl(entry.path)} ${entry.width}w`)
        .join(", "),
    });
  }

  /*
   * The fallback `src` is the largest WebP the asset has.
   *
   * It is what a browser that ignores `srcset` fetches, so it has to be the best
   * available rendering rather than whatever happens to sit at one end of the
   * index's array. The array's order is the materialiser's business — today it
   * runs smallest to largest and ends with the untouched original — and reading
   * either end of it would be relying on that. `derivativesFor` sorts by width,
   * so it is asked instead, and the largest derivative of any format is the last
   * resort for an asset that has no WebP at all.
   */
  const fallback =
    derivativesFor(asset, "webp")[0] ??
    largestDerivative(asset) ??
    asset.derivatives[0] ??
    null;

  return {
    src: mediaUrl(fallback?.path ?? publicPath),
    width: options.displayWidth,
    height: options.displayHeight,
    sources,
    sizes: options.sizes,
    available: true,
    intrinsic:
      asset.width === null || asset.height === null
        ? null
        : { width: asset.width, height: asset.height },
  };
}

/** The widest derivative of an asset, whatever format it is in. */
function largestDerivative(asset: MediaAsset): MediaDerivative | null {
  let widest: MediaDerivative | null = null;
  for (const derivative of asset.derivatives) {
    if (widest === null || derivative.width > widest.width) widest = derivative;
  }
  return widest;
}
