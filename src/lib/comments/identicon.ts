/**
 * A deterministic fallback avatar.
 *
 * Most commenters will not have a Gravatar, and a request for one returns a
 * default image rather than a 404, so "no avatar" is not distinguishable from
 * "avatar" by status code alone — the proxy checks for Gravatar's own default
 * and substitutes this instead. Without it every commenter without an account
 * would wear the same anonymous silhouette.
 *
 * The design is deliberately plain and derivable from the hash alone: a 5×5
 * grid, mirrored left-to-right so it reads as a face-like mark rather than as
 * noise, drawn in one hue taken from the same hash. That makes it stable across
 * requests and across servers, which is the property that matters — an avatar
 * that changed on every render would be worse than none.
 *
 * Returned as an SVG string. SVG is safe to serve from our own origin here
 * because the content is generated from a hex digest with no text content, no
 * script, no external references and no author-supplied strings: every value in
 * the output is either a fixed literal or a hex character from the input, which
 * is validated first.
 */

/** Colours chosen to stay legible against both the light and dark surfaces. */
const HUES = [199, 173, 262, 22, 340, 145, 47, 215] as const;

export interface IdenticonOptions {
  /** Digest to derive the mark from. Anything non-hex is rejected. */
  readonly hash: string;
  readonly size?: number;
}

/**
 * Build an identicon for a hex digest.
 *
 * @throws when the hash is not hex, because the generated SVG interpolates it
 *   into a colour and silently accepting arbitrary text would mean this function
 *   could be used to inject markup.
 */
export function identiconSvg(options: IdenticonOptions): string {
  const { hash, size = 80 } = options;

  if (!/^[0-9a-f]+$/iu.test(hash) || hash.length < 8) {
    throw new Error(
      "identiconSvg needs a hex digest of at least 8 characters to derive a mark from.",
    );
  }

  /*
   * `size` is interpolated into `viewBox`, `width` and `height`, so it is the
   * one value through which something other than a digest-derived number or a
   * literal could reach the output this module promises is built from exactly
   * those. The avatar endpoint passes a literal 160 and could never trigger
   * this; the check is here because the guarantee belongs to the function, not
   * to the one caller that happens to exist today.
   */
  if (!Number.isInteger(size) || size < 16 || size > 1024) {
    throw new Error("identiconSvg needs an integer size between 16 and 1024.");
  }

  const digits = hash.toLowerCase();
  const byte = (index: number): number =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);

  const hue = HUES[byte(0) % HUES.length] ?? 199;
  const saturation = 42 + (byte(1) % 24);
  const lightness = 40 + (byte(2) % 18);

  const background = `hsl(${String(hue)} ${String(saturation - 30)}% ${String(lightness + 42)}%)`;
  const foreground = `hsl(${String(hue)} ${String(saturation)}% ${String(lightness)}%)`;

  /*
   * A 3×5 field mirrored into 5×5: the left three columns come from the digest
   * and the right two repeat them, so the mark is symmetric and 15 bits of the
   * hash are enough to make it distinctive.
   */
  const cell = size / 5;
  const squares: string[] = [];
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 5; row += 1) {
      const index = column * 5 + row;
      const value = byte(3 + Math.floor(index / 4));
      if ((value >> (index % 4)) % 2 === 1) {
        const x = column * cell;
        const y = row * cell;
        squares.push(
          `<rect x="${String(x)}" y="${String(y)}" width="${String(cell)}" height="${String(cell)}"/>`,
        );
        const mirrored = size - cell * (column + 1);
        if (mirrored !== x) {
          squares.push(
            `<rect x="${String(mirrored)}" y="${String(y)}" width="${String(cell)}" height="${String(cell)}"/>`,
          );
        }
      }
    }
  }

  /*
   * Every interpolated value below is a number this function computed from a
   * validated hex digest, or a literal. No caller-supplied string reaches the
   * output, which is why the result can be served as-is.
   */
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}" width="${String(size)}" height="${String(size)}" role="img" aria-hidden="true">`,
    `<rect width="${String(size)}" height="${String(size)}" fill="${background}"/>`,
    `<g fill="${foreground}">${squares.join("")}</g>`,
    `</svg>`,
  ].join("");
}
