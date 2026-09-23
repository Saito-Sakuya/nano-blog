import { describe, expect, it } from "vitest";

import {
  codePointLength,
  compareCodePoints,
  graphemeClusters,
  hasLoneSurrogate,
  sortByCodePoints,
  truncateCodePoints,
  truncateGraphemes,
} from "../../scripts/lib/unicode";

/**
 * `unicode.ts` is depended on by the path and length contracts, so the cases
 * here are the ones those contracts would break on: a description counted in
 * UTF-16 units, a path ordered by surrogate half, and a truncation that cuts a
 * user-perceived character in half.
 */

/** `é` written as `e` plus U+0301 COMBINING ACUTE ACCENT, followed by `x`. */
const COMBINING = "e\u0301x";
/** One family emoji: four people joined by zero-width joiners. */
const ZWJ_FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
/** The Japanese flag: a pair of regional indicators. */
const FLAG_JP = "\u{1F1EF}\u{1F1F5}";
/** A heart followed by U+FE0F VARIATION SELECTOR-16. */
const HEART = "\u2764\uFE0F";
/** One astral character: a single code point in two UTF-16 units. */
const EMOJI = "\u{1F600}";

describe("codePointLength", () => {
  it("counts astral characters as one", () => {
    expect(codePointLength(EMOJI)).toBe(1);
    expect(EMOJI.length).toBe(2);
  });

  it("counts a combining sequence as the code points it is made of", () => {
    expect(codePointLength(COMBINING)).toBe(3);
  });

  it("is zero for the empty string", () => {
    expect(codePointLength("")).toBe(0);
  });
});

describe("truncateCodePoints", () => {
  it("keeps a plain ASCII prefix", () => {
    expect(truncateCodePoints("abcdef", 3)).toBe("abc");
    expect(truncateCodePoints("abcdef", 6)).toBe("abcdef");
    expect(truncateCodePoints("abcdef", 99)).toBe("abcdef");
  });

  it("never splits a surrogate pair", () => {
    expect(truncateCodePoints(`${EMOJI}${EMOJI}`, 1)).toBe(EMOJI);
    expect(codePointLength(truncateCodePoints(`${EMOJI}${EMOJI}`, 1))).toBe(1);
  });

  it("never cuts a combining mark away from its base letter", () => {
    // `"e"` alone would be a different string from a prefix of the input: the
    // accent is part of the character, so the whole cluster is dropped.
    expect(truncateCodePoints(COMBINING, 1)).toBe("");
    expect(truncateCodePoints(COMBINING, 2)).toBe("e\u0301");
    expect(truncateCodePoints(COMBINING, 3)).toBe(COMBINING);
  });

  it("never splits a zero-width-joiner emoji sequence", () => {
    expect(codePointLength(ZWJ_FAMILY)).toBe(7);
    expect(truncateCodePoints(ZWJ_FAMILY, 6)).toBe("");
    expect(truncateCodePoints(`${ZWJ_FAMILY}x`, 7)).toBe(ZWJ_FAMILY);
  });

  it("never splits a regional-indicator pair", () => {
    expect(truncateCodePoints(FLAG_JP, 1)).toBe("");
    expect(truncateCodePoints(FLAG_JP, 2)).toBe(FLAG_JP);
  });

  it("never splits a variation selector away from its base", () => {
    expect(truncateCodePoints(HEART, 1)).toBe("");
    expect(truncateCodePoints(HEART, 2)).toBe(HEART);
  });

  it("never exceeds the budget, whatever the input", () => {
    const inputs = [COMBINING, ZWJ_FAMILY, FLAG_JP, HEART, EMOJI, "abc"];
    for (const input of inputs) {
      for (let max = 0; max <= 8; max += 1) {
        const truncated = truncateCodePoints(input, max);
        expect(codePointLength(truncated)).toBeLessThanOrEqual(max);
        expect(input.startsWith(truncated)).toBe(true);
      }
    }
  });

  it("returns nothing for an unusable budget", () => {
    expect(truncateCodePoints("abc", 0)).toBe("");
    expect(truncateCodePoints("abc", -1)).toBe("");
    expect(truncateCodePoints("abc", Number.NaN)).toBe("");
  });
});

describe("truncateGraphemes", () => {
  it("counts user-perceived characters, not code points", () => {
    expect(truncateGraphemes("abc", 2)).toBe("ab");
    expect(truncateGraphemes(COMBINING, 1)).toBe("e\u0301");
    expect(truncateGraphemes(`${ZWJ_FAMILY}x`, 1)).toBe(ZWJ_FAMILY);
    expect(truncateGraphemes(`${FLAG_JP}x`, 1)).toBe(FLAG_JP);
    expect(truncateGraphemes(`${HEART}x`, 1)).toBe(HEART);
  });

  it("returns nothing for an unusable budget", () => {
    expect(truncateGraphemes("abc", 0)).toBe("");
    expect(truncateGraphemes("abc", Number.NaN)).toBe("");
  });
});

describe("graphemeClusters", () => {
  it("groups a base letter with its combining mark", () => {
    expect(graphemeClusters(COMBINING)).toEqual(["e\u0301", "x"]);
  });

  it("groups a ZWJ sequence into one cluster", () => {
    expect(graphemeClusters(`${ZWJ_FAMILY}${EMOJI}`)).toEqual([
      ZWJ_FAMILY,
      EMOJI,
    ]);
  });
});

describe("compareCodePoints", () => {
  it("orders astral characters above the private-use block, as code points do", () => {
    // JavaScript's `<` compares surrogate halves, which puts U+1F600 *below*
    // U+E000; the manifest ordering rule needs the code-point order instead.
    expect(compareCodePoints(EMOJI, "\uE000")).toBe(1);
    expect(compareCodePoints("\uE000", EMOJI)).toBe(-1);
  });

  it("treats equal strings as equal and sorts without mutating", () => {
    const values = ["b", "a", EMOJI];
    expect(compareCodePoints("a", "a")).toBe(0);
    expect(sortByCodePoints(values)).toEqual(["a", "b", EMOJI]);
    expect(values).toEqual(["b", "a", EMOJI]);
  });
});

describe("hasLoneSurrogate", () => {
  it("accepts a complete pair and rejects half of one", () => {
    expect(hasLoneSurrogate(EMOJI)).toBe(false);
    expect(hasLoneSurrogate(EMOJI.slice(0, 1))).toBe(true);
  });
});
