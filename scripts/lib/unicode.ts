/**
 * Unicode helpers used wherever a length or an ordering is part of a contract.
 *
 * Two separate concerns live here, and both matter:
 *
 * - **Length** is counted in Unicode code points, never in UTF-16 units, so a
 *   Chinese description is not silently allowed to be twice as long as a Latin
 *   one just because it fits in the same number of bytes.
 * - **Ordering** is by code point, not by UTF-16 code unit. JavaScript's `<`
 *   compares surrogate halves, which puts every astral character below `U+E000`
 *   and would order manifest paths differently from this module.
 *
 * **Truncation** is a third: cutting a string at a code-point boundary is not
 * enough, because a single user-perceived character can be several code points
 * — `e` plus a combining acute, a ZWJ emoji sequence, a regional-indicator
 * pair, a variation selector. A cut inside one of those leaves a string that
 * renders as something other than a prefix of the original, so truncation is
 * done on grapheme clusters and rounded *down*: the result never exceeds the
 * budget it was given.
 */

/** Number of Unicode code points in a string. */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

/**
 * Text segmentation, by the Unicode rules rather than by a list of ranges kept
 * here: combining marks, ZWJ sequences, regional-indicator pairs, variation
 * selectors and tag sequences are all one cluster each. `Intl.Segmenter` is
 * part of the runtime this project targets (Node 24), so the rules do not have
 * to be re-stated — and cannot drift away from the standard.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Every user-perceived character of `value`, in order. */
export function graphemeClusters(value: string): string[] {
  const clusters: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    clusters.push(segment);
  }
  return clusters;
}

/**
 * The first `max` code points of a string, without splitting a surrogate pair
 * *or* a grapheme cluster.
 *
 * A cluster that would cross the boundary is dropped whole rather than cut, so
 * the result can be shorter than `max` code points but never longer — the
 * budget callers enforce with `codePointLength` still holds. `"e\u0301x"` with
 * `max` 1 is therefore `""`, not `"e"`: the accent and the letter it belongs to
 * stay together or not at all.
 */
export function truncateCodePoints(value: string, max: number): string {
  // `!(max > 0)` covers 0, negatives and NaN in one condition: an unusable
  // budget produces nothing rather than the whole string.
  if (!(max > 0)) return "";
  if (codePointLength(value) <= max) return value;

  let result = "";
  let count = 0;
  for (const cluster of graphemeClusters(value)) {
    const length = codePointLength(cluster);
    if (count + length > max) break;
    result += cluster;
    count += length;
  }
  return result;
}

/** The first `max` grapheme clusters of a string. */
export function truncateGraphemes(value: string, max: number): string {
  if (!(max > 0)) return "";
  return graphemeClusters(value).slice(0, max).join("");
}

/** Compare two strings by Unicode code point, ascending. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();

  for (;;) {
    const nextLeft = left.next();
    const nextRight = right.next();

    if (nextLeft.done === true && nextRight.done === true) return 0;
    if (nextLeft.done === true) return -1;
    if (nextRight.done === true) return 1;

    const leftPoint = nextLeft.value.codePointAt(0) ?? 0;
    const rightPoint = nextRight.value.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

/** Sort a list of strings by Unicode code point without mutating the input. */
export function sortByCodePoints(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoints);
}

/** True when the string is already in Unicode NFC form. */
export function isNfc(value: string): boolean {
  return value === value.normalize("NFC");
}

/**
 * True for C0 controls (including tab, newline and carriage return), DEL, and
 * the C1 block.
 *
 * Written as arithmetic on code points rather than a regular-expression
 * character class: a class written with literal control characters is
 * invisible in a diff and turns the file into something grep calls binary.
 */
export function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

/** True when the string contains a control character of any kind. */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isControlCodePoint(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * True when the string contains a control character that is never legitimate
 * in text: everything except tab, newline and carriage return.
 */
export function hasBinaryControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
      continue;
    if (isControlCodePoint(codePoint)) return true;
  }
  return false;
}

/** True when the string contains a lone UTF-16 surrogate. */
export function hasLoneSurrogate(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    // Iterating a string yields a lone surrogate only where the pair is broken.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}

/**
 * Lower-case a path for case-insensitive collision checks. Uses the Unicode
 * simple case mapping that `toLowerCase` implements, which is the same mapping
 * Windows and macOS use for filenames.
 */
export function foldCase(value: string): string {
  return value.toLowerCase();
}

/**
 * Drop the combining marks NFKD decomposed a Latin letter into.
 *
 * Written as code-point arithmetic rather than a regular-expression character
 * class, because a class holding literal combining marks is invisible in
 * review and impossible to see in a diff.
 */
function stripCombiningMarks(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x300 && codePoint <= 0x36f) continue;
    result += character;
  }
  return result;
}

/**
 * A stable, filesystem-safe slug for a suggestion file name: ASCII letters,
 * digits and hyphens only.
 */
export function slugifyAscii(value: string, max = 60): string {
  const ascii = stripCombiningMarks(value.normalize("NFKD"))
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  const trimmed = ascii.slice(0, max).replace(/-+$/gu, "");
  return trimmed.length > 0 ? trimmed : "suggestion";
}
