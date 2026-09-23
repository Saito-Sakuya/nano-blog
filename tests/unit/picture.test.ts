import { describe, expect, it } from "vitest";

import type { MediaAsset, MediaIndex } from "../../src/lib/media/index";
import { buildPicture, mediaUrl } from "../../src/lib/media/picture";

/**
 * Responsive picture data.
 *
 * Two things here are easy to get wrong and invisible when wrong. The `sizes`
 * value is what tells the browser how wide the image will be drawn — the
 * `srcset` is useless without it, and a `sizes` that describes a different box
 * from the layout simply picks from the wrong rung of the ladder. And the
 * fallback `src` is what a browser without `srcset` support fetches, so it has
 * to be the best rendering the asset has rather than whichever entry happens to
 * sit at one end of the index's array.
 */

const SHA = "0".repeat(64);

function derivative(
  width: number,
  format: MediaAsset["derivatives"][number]["format"],
  extension: string,
): MediaAsset["derivatives"][number] {
  return {
    width,
    format,
    path: `/media/${SHA}/${String(width)}.${extension}`,
    bytes: width,
    sha256: `${String(width)}`.padStart(64, "0"),
  };
}

function asset(derivatives: MediaAsset["derivatives"]): MediaAsset {
  return {
    sourceSha256: SHA,
    kind: "image",
    mime: "image/png",
    alt: "测试图案",
    width: 1200,
    height: 675,
    bytes: 17149,
    localPath: `media/${SHA}/1200.webp`,
    derivatives,
  };
}

function indexWith(entry: MediaAsset): MediaIndex {
  return { schemaVersion: 1, assets: [entry] };
}

/** The public path of the largest derivative, without its media origin. */
const COVER = `/media/${SHA}/1200.webp`;

describe("buildPicture — the sizes attribute", () => {
  it("hands the caller's sizes value back for the markup to use", () => {
    const sizes = "(min-width: 75rem) 900px, 100vw";
    const picture = buildPicture(
      indexWith(asset([derivative(800, "webp", "webp")])),
      COVER,
      { displayWidth: 900, displayHeight: 506, sizes },
    );

    expect(picture.sizes).toBe(sizes);
  });

  it("still reports sizes when the asset is not in the index", () => {
    // The unoptimised path renders at the declared box, and that box is still
    // described by the same value; a missing media record must not also lose the
    // layout's own description of itself.
    const sizes = "(min-width: 48rem) 42rem, 100vw";
    const picture = buildPicture({ schemaVersion: 1, assets: [] }, COVER, {
      displayWidth: 900,
      displayHeight: 506,
      sizes,
    });

    expect(picture.available).toBe(false);
    expect(picture.sizes).toBe(sizes);
    expect(picture.sources).toEqual([]);
  });
});

describe("buildPicture — the format ladders", () => {
  it("emits avif and webp largest-first, with absolute URLs", () => {
    const picture = buildPicture(
      indexWith(
        asset([
          derivative(480, "webp", "webp"),
          derivative(1200, "avif", "avif"),
          derivative(480, "avif", "avif"),
          derivative(1200, "webp", "webp"),
        ]),
      ),
      COVER,
      { displayWidth: 900, displayHeight: 506, sizes: "100vw" },
    );

    expect(picture.sources.map((source) => source.type)).toEqual([
      "image/avif",
      "image/webp",
    ]);
    expect(picture.sources[0]?.srcset).toBe(
      `${mediaUrl(`/media/${SHA}/1200.avif`)} 1200w, ${mediaUrl(`/media/${SHA}/480.avif`)} 480w`,
    );
    expect(picture.sources[1]?.srcset).toBe(
      `${mediaUrl(`/media/${SHA}/1200.webp`)} 1200w, ${mediaUrl(`/media/${SHA}/480.webp`)} 480w`,
    );
  });
});

describe("buildPicture — the fallback src", () => {
  /** The order the materialiser writes today: ascending, original last. */
  const TODAYS_ORDER = [
    derivative(480, "avif", "avif"),
    derivative(480, "webp", "webp"),
    derivative(800, "avif", "avif"),
    derivative(800, "webp", "webp"),
    derivative(1200, "avif", "avif"),
    derivative(1200, "webp", "webp"),
    derivative(1200, "original", "png"),
  ];

  it("takes the largest webp of the ladder", () => {
    const picture = buildPicture(indexWith(asset(TODAYS_ORDER)), COVER, {
      displayWidth: 900,
      displayHeight: 506,
      sizes: "100vw",
    });

    expect(picture.src).toBe(mediaUrl(`/media/${SHA}/1200.webp`));
  });

  it("does not depend on the order of the index's array", () => {
    // The array's order is the materialiser's business, not this module's: read
    // from the wrong end and a browser without `srcset` gets a 480px thumbnail
    // stretched across the article.
    const reversed = [...TODAYS_ORDER].reverse();
    const picture = buildPicture(indexWith(asset(reversed)), COVER, {
      displayWidth: 900,
      displayHeight: 506,
      sizes: "100vw",
    });

    expect(picture.src).toBe(mediaUrl(`/media/${SHA}/1200.webp`));
  });

  it("falls back to the widest derivative of any format when there is no webp", () => {
    const picture = buildPicture(
      indexWith(
        asset([
          derivative(1200, "original", "png"),
          derivative(480, "avif", "avif"),
          derivative(800, "avif", "avif"),
        ]),
      ),
      COVER,
      { displayWidth: 900, displayHeight: 506, sizes: "100vw" },
    );

    expect(picture.src).toBe(mediaUrl(`/media/${SHA}/1200.png`));
  });

  it("uses the referenced path itself when the asset has no derivatives at all", () => {
    const picture = buildPicture(indexWith(asset([])), COVER, {
      displayWidth: 900,
      displayHeight: 506,
      sizes: "100vw",
    });

    expect(picture.src).toBe(mediaUrl(COVER));
  });
});

describe("buildPicture — the declared box", () => {
  it("keeps the caller's box and adds the asset's own pixel size", () => {
    const picture = buildPicture(
      indexWith(asset([derivative(1200, "webp", "webp")])),
      COVER,
      { displayWidth: 240, displayHeight: 135, sizes: "240px" },
    );

    expect(picture.width).toBe(240);
    expect(picture.height).toBe(135);
    // The intrinsic ratio is what lets a caller reserve a box without assuming
    // 16:9, so it must be the asset's own numbers.
    expect(picture.intrinsic).toEqual({ width: 1200, height: 675 });
  });

  it("reports no intrinsic size for an asset it does not know", () => {
    const picture = buildPicture(
      { schemaVersion: 1, assets: [] },
      "/cover.png",
      {
        displayWidth: 240,
        displayHeight: 135,
        sizes: "240px",
      },
    );

    expect(picture.intrinsic).toBeNull();
    // A path that is not a media path is used as it is: it is already a URL.
    expect(picture.src).toBe("/cover.png");
  });
});
