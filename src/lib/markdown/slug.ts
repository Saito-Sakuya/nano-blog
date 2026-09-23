import { createHash } from "node:crypto";

/**
 * Heading slugs.
 *
 * The algorithm is fixed by the site specification and must stay stable
 * forever: a published anchor is a permanent address, and changing the rule
 * would silently break every existing link into an article.
 *
 * - A pure-Latin heading is normalised to NFC, lower-cased, has whitespace
 *   turned into hyphens, and has every non-ASCII slug character removed.
 * - A heading that contains CJK text, or that collapses to nothing after the
 *   transformation above, falls back to `section-<hash8>`, where `hash8` is the
 *   first eight hex characters of the SHA-256 of the NFC heading text. This
 *   keeps anchors readable-ish, stable and collision-resistant without
 *   transliterating Chinese into a meaningless Latin guess.
 * - Repeated slugs get `-2`, `-3`, … in document order, skipping any slug that
 *   is already in use, so the ids a document emits are unique even when one
 *   heading's own text ends in a suffix: `A`, `A`, `A-2` → `a`, `a-2`, `a-2-2`.
 *   The suffix is always attached to the heading's own base slug, which is what
 *   keeps the id derivable from the heading text.
 */

/**
 * CJK ranges that force the hash fallback: CJK symbols and punctuation, kana,
 * Han (extension A, unified, compatibility), full-width forms and Hangul.
 */
const CJK_PATTERN = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/u;

/** First eight hex characters of the SHA-256 of the NFC-normalised text. */
function hash8(text: string): string {
  return createHash("sha256")
    .update(text.normalize("NFC"), "utf8")
    .digest("hex")
    .slice(0, 8);
}

/**
 * Turn one heading's text into its base slug, before duplicate handling.
 */
export function slugifyHeading(text: string): string {
  const nfc = text.normalize("NFC");
  if (CJK_PATTERN.test(nfc)) {
    return `section-${hash8(nfc)}`;
  }

  const ascii = nfc
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "");

  if (ascii.length === 0) {
    return `section-${hash8(nfc)}`;
  }
  return ascii;
}

/**
 * A stateful slugger for a single document. Duplicate slugs are suffixed in the
 * order the headings appear.
 *
 * Uniqueness is enforced against the slugs already handed out, not against a
 * count of each base slug. Counting the base was wrong as soon as one heading's
 * text already ended in a suffix: `## A`, `## A`, `## A-2` produced `a`, `a-2`,
 * `a-2`, because the third heading *is* `a-2` and the second had taken it. Two
 * headings sharing a DOM id is a broken anchor and an ambiguous table of
 * contents, not a cosmetic detail, so the suffix search skips every slug that
 * is already in use — and the suffix always attaches to the heading's own base,
 * so `A-2` after `A` and `A` becomes `a-2-2` rather than taking an unrelated
 * `a-3` that a heading written `A-3` would expect to own.
 */
export function createHeadingSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text: string): string => {
    const base = slugifyHeading(text);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;

    const slug = `${base}-${suffix}`;
    used.add(slug);
    return slug;
  };
}
