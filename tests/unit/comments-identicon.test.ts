import { describe, expect, it } from "vitest";

import { identiconSvg } from "../../src/lib/comments/identicon";

/**
 * The fallback avatar.
 *
 * Two properties matter, and neither is aesthetic: the mark must be **stable**
 * for a given commenter — an avatar that changed between page loads would be
 * worse than no avatar at all — and its output must be **safe to serve**, since
 * it is returned from our own origin as a document the browser will render.
 */

const HASH = "0bc83cb571cd1c50ba6f3e8a78ef1346";

describe("identiconSvg — stability", () => {
  it("returns the same mark for the same hash", () => {
    expect(identiconSvg({ hash: HASH })).toBe(identiconSvg({ hash: HASH }));
  });

  it("returns different marks for different commenters", () => {
    const other = identiconSvg({ hash: "57edf4a22be3c955ac49da2e2107b67a" });
    expect(identiconSvg({ hash: HASH })).not.toBe(other);
  });

  it("treats an upper-case hash as the same commenter", () => {
    // Digests arrive lower-cased, but a caller passing one in upper case should
    // not produce a different avatar for the same person.
    expect(identiconSvg({ hash: HASH.toUpperCase() })).toBe(
      identiconSvg({ hash: HASH }),
    );
  });

  it("is not affected by the size, only scaled by it", () => {
    const small = identiconSvg({ hash: HASH, size: 40 });
    const large = identiconSvg({ hash: HASH, size: 80 });
    expect(small).toContain('viewBox="0 0 40 40"');
    expect(large).toContain('viewBox="0 0 80 80"');
    // Same number of rects: the mark is the same, only its units differ.
    const count = (value: string): number =>
      (value.match(/<rect/gu) ?? []).length;
    expect(count(small)).toBe(count(large));
  });
});

describe("identiconSvg — output is safe to serve", () => {
  it("contains no script, no event handler and no external reference", () => {
    const svg = identiconSvg({ hash: HASH });
    const lowered = svg.toLowerCase();
    for (const needle of [
      "<script",
      "onload",
      "onerror",
      "onclick",
      "href",
      "xlink",
      "javascript:",
      "data:",
      "<foreignobject",
      "<image",
    ]) {
      expect(lowered, `identicon contains ${needle}`).not.toContain(needle);
    }
  });

  it("is a single self-contained svg element", () => {
    const svg = identiconSvg({ hash: HASH });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect((svg.match(/<svg/gu) ?? []).length).toBe(1);
  });

  it("is hidden from assistive technology, because the name is beside it", () => {
    // The commenter's name is already announced next to the avatar; an
    // unlabelled or duplicated announcement would be noise.
    expect(identiconSvg({ hash: HASH })).toContain('aria-hidden="true"');
  });

  it("emits no text content, so nothing a caller supplies can be displayed", () => {
    const svg = identiconSvg({ hash: HASH });
    // Strip the markup and the attribute values; what remains should be nothing
    // but whitespace.
    const withoutTags = svg.replace(/<[^>]*>/gu, "").replace(/"[^"]*"/gu, "");
    expect(withoutTags.trim()).toBe("");
  });
});

describe("identiconSvg — input validation", () => {
  it("refuses a hash that is not hex", () => {
    // The values are interpolated into the document, so accepting arbitrary
    // text here would make this function a way to inject markup.
    for (const hash of [
      "not-a-hash",
      "0bc83cb571cd1c50ba6f3e8a78ef134z",
      "<script>alert(1)</script>",
      '"><script>alert(1)</script>',
      "12345",
      "",
    ]) {
      expect(() => identiconSvg({ hash }), hash).toThrow();
    }
  });

  it("accepts a digest of the minimum length", () => {
    expect(() => identiconSvg({ hash: "01234567" })).not.toThrow();
  });

  it("refuses a hash shorter than the mark needs", () => {
    expect(() => identiconSvg({ hash: "0123" })).toThrow();
  });
});
