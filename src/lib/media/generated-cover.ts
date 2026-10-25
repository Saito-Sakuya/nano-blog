/**
 * Generated covers.
 *
 * Most posts have no photograph worth putting on a list row, and a cover that
 * fails to load used to leave a pale panel with the title's first character in
 * it. This draws something better for that panel: a field of small squares in
 * a hue derived from the post, denser towards one edge, with exactly one
 * larger square in the brand cyan — the small find the tagline is about.
 *
 * It is only ever a fallback. A post's own cover image is always drawn first;
 * this sits behind it in the frame's fallback slot and shows when the image is
 * missing or fails.
 *
 * Everything is decided by the seed, so a post keeps the same cover across
 * builds, and nothing runs in the browser: the result is inline SVG whose
 * colours come from CSS (`--cover-ink`, `--color-brand`), which is what lets
 * one cover follow the light and dark themes.
 *
 * Size matters because a list page carries one of these per row in two shapes.
 * Squares are bucketed by opacity into five paths instead of one element each,
 * which keeps a cover to a handful of elements: 1–3KB of markup for the list
 * shapes, under 14KB for the article shapes.
 */

export type CoverShape = "tile" | "band" | "header" | "card";

interface ShapeSpec {
  readonly width: number;
  readonly height: number;
  /** Distance between square origins. */
  readonly pitch: number;
  /** Side of one square. */
  readonly cell: number;
  /** Which way density grows: towards the trailing edge, or the far corner. */
  readonly ramp: "trailing" | "diagonal";
  /**
   * The column range, as fractions of the width, the cyan square may land in.
   *
   * The band and the header are faded towards their leading edge by a mask in
   * the stylesheet, and a find drawn inside that fade comes out washed out. The
   * range keeps it where the mask is fully opaque.
   */
  readonly find: readonly [number, number];
}

const SHAPES: Readonly<Record<CoverShape, ShapeSpec>> = {
  tile: {
    width: 64,
    height: 64,
    pitch: 8,
    cell: 4,
    ramp: "diagonal",
    find: [0.15, 0.7],
  },
  band: {
    width: 240,
    height: 96,
    pitch: 12,
    cell: 6,
    ramp: "trailing",
    find: [0.8, 0.9],
  },
  // The two article shapes use a coarser grid: an article page carries both,
  // and a fine grid at header size is tens of kilobytes of path data.
  header: {
    width: 960,
    height: 300,
    pitch: 20,
    cell: 9,
    ramp: "trailing",
    find: [0.76, 0.9],
  },
  card: {
    width: 480,
    height: 270,
    pitch: 16,
    cell: 7,
    ramp: "diagonal",
    find: [0.15, 0.8],
  },
};

/** Opacity levels the squares are bucketed into. */
const LEVELS = [0.1, 0.28, 0.46, 0.66, 0.88] as const;

/** FNV-1a: small, stable across platforms, and good enough to spread seeds. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** Mulberry32: a deterministic stream of floats in [0, 1) from one seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The hue a post's cover is drawn in.
 *
 * The 60° around the brand cyan are skipped, so the one cyan square always
 * stands apart from the field it sits in.
 */
export function coverHue(seed: string): number {
  return (220 + (hash(seed) % 300)) % 360;
}

/**
 * Draw one cover as an SVG string.
 *
 * The markup contains only numbers produced here and fixed class names — no
 * part of the seed is written into it — so it is safe to emit with `set:html`.
 */
export function generatedCoverSvg(seed: string, shape: CoverShape): string {
  const spec = SHAPES[shape];
  // Each shape draws from its own stream, so the tile and the band of one
  // post are related by hue but are not the same picture cropped differently.
  const next = random(hash(`${shape}:${seed}`));

  const columns = Math.floor(spec.width / spec.pitch);
  const rows = Math.floor(spec.height / spec.pitch);
  const inset = (spec.pitch - spec.cell) / 2;

  const [from, to] = spec.find;
  const findColumn = Math.min(
    columns - 2,
    Math.floor(columns * (from + next() * (to - from))),
  );
  const findRow =
    spec.ramp === "diagonal"
      ? 1 + Math.floor(next() * (rows - 3))
      : Math.floor(next() * (rows - 1));

  const paths = LEVELS.map(() => "");
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const underFind =
        (column === findColumn || column === findColumn + 1) &&
        (row === findRow || row === findRow + 1);
      if (underFind) continue;

      const t =
        spec.ramp === "diagonal"
          ? (column + row) / (columns + rows - 2)
          : column / (columns - 1);
      // Sparser where the field is faint, so the fade reads as thinning out
      // rather than as a uniform grid going grey.
      if (next() < 0.22 * (1 - t) + 0.06) continue;

      const alpha = 0.07 + 0.7 * t ** 1.3 + (next() - 0.5) * 0.3;
      let level = 0;
      for (const [index, threshold] of LEVELS.entries()) {
        if (alpha >= threshold - 0.09) level = index;
      }

      const x = column * spec.pitch + inset;
      const y = row * spec.pitch + inset;
      paths[level] += `M${x} ${y}h${spec.cell}v${spec.cell}h-${spec.cell}z`;
    }
  }

  const body = paths
    .map((d, index) =>
      d === "" ? "" : `<path d="${d}" opacity="${LEVELS[index]}"/>`,
    )
    .join("");
  const findX = findColumn * spec.pitch + inset;
  const findY = findRow * spec.pitch + inset;
  const findSize = spec.pitch + spec.cell;

  return (
    `<svg class="generated-cover generated-cover--${shape}" viewBox="0 0 ${spec.width} ${spec.height}" ` +
    `preserveAspectRatio="xMaxYMid slice" aria-hidden="true" focusable="false">` +
    body +
    `<rect class="generated-cover__find" x="${findX}" y="${findY}" width="${findSize}" height="${findSize}"/>` +
    `</svg>`
  );
}
