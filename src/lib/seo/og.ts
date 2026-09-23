import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { localAssetPath, loadMediaIndex, findAsset } from "../media/index.js";
import {
  OG_DEFAULT_CARD_PATH,
  OG_DEFAULT_KEY,
  OG_HEIGHT,
  OG_WIDTH,
  ogCardPath,
} from "../site.js";

/**
 * Open Graph cards.
 *
 * Every card is 1200×630 and generated at build time with `sharp`. Nothing is
 * drawn with a remote font or a web service, because either would break the
 * "no third-party request" rule and could fail unpredictably.
 *
 * Text on a card is ASCII only — `nano-blog` — so the build never depends on a
 * machine having a Chinese font installed. Card keys are derived from the
 * inputs, so changing a cover changes the file name and the old card can never
 * be served by mistake.
 *
 * The card's size and the fallback card's key live in `site.ts` beside the rest
 * of the site's identity: the page metadata that declares `og:image:width`
 * needs the same two numbers, and it cannot import them from here without
 * dragging `sharp` and the filesystem into every page's module graph.
 */

export { OG_DEFAULT_KEY, OG_HEIGHT, OG_WIDTH };

const BAND_HEIGHT = 72;
const DARK = "#111A1D";
const LIGHT_TEXT = "#E8EFEF";
const LIGHT_BG = "#F7F5EF";
const DARK_TEXT = "#172125";
const BRAND = "#00A2BD";

/** Deterministic key for a cover, so identical inputs reuse one file. */
export function ogKeyForCover(coverSrc: string): string {
  return createHash("sha256").update(coverSrc).digest("hex").slice(0, 16);
}

/** Public path of the card for a cover, or the default card when there is none. */
export function ogImagePath(coverSrc: string | undefined): string {
  if (coverSrc === undefined) return OG_DEFAULT_CARD_PATH;
  return ogCardPath(ogKeyForCover(coverSrc));
}

/**
 * The wordmark strip. `x`/`y` place the cyan square; the text follows it at a
 * fixed optical distance.
 */
function wordmark(x: number, y: number, size: number, color: string): string {
  const square = Math.round(size * 0.58);
  const textX = x + square + Math.round(size * 0.42);
  const baseline = y + Math.round(size * 0.78);
  return `
    <rect x="${x}" y="${y}" width="${square}" height="${square}" fill="${BRAND}" />
    <text x="${textX}" y="${baseline}" font-family="Helvetica, Arial, sans-serif"
          font-size="${size}" font-weight="600" fill="${color}">nano-blog</text>`;
}

/** The default card: a flat ground, the wordmark, nothing else. */
export async function renderDefaultCard(): Promise<Buffer> {
  const size = 56;
  const x = Math.round(
    (OG_WIDTH - (size * 0.58 + size * 0.42 + size * 3.6)) / 2,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">
    <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${LIGHT_BG}" />
    ${wordmark(x, Math.round((OG_HEIGHT - size) / 2), size, DARK_TEXT)}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * A card built on an article's cover: a centre crop with a solid dark band
 * along the bottom carrying the wordmark. No headline is drawn, so the card
 * reads the same on every machine.
 */
export async function renderCoverCard(coverSrc: string): Promise<Buffer> {
  const index = loadMediaIndex();
  const asset = findAsset(index, coverSrc);

  if (asset === null) {
    throw new Error(
      `No media record for cover ${coverSrc}. Run content:validate to see which article references a missing asset.`,
    );
  }

  let source: Buffer;
  try {
    source = await readFile(localAssetPath(asset));
  } catch (cause) {
    throw new Error(
      `Cover file for ${coverSrc} is missing from the build input at ${asset.localPath}. ` +
        "The media index and the materialised media must be produced together.",
      { cause },
    );
  }

  const base = await sharp(source)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: "cover", position: "centre" })
    .toBuffer();

  const size = 30;
  const bandTop = OG_HEIGHT - BAND_HEIGHT;
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">
    <rect x="0" y="${bandTop}" width="${OG_WIDTH}" height="${BAND_HEIGHT}" fill="${DARK}" />
    ${wordmark(48, bandTop + Math.round((BAND_HEIGHT - size) / 2), size, LIGHT_TEXT)}
  </svg>`;

  return sharp(base)
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
