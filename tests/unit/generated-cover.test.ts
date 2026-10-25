import { describe, expect, it } from "vitest";

import {
  coverHue,
  generatedCoverSvg,
  type CoverShape,
} from "../../src/lib/media/generated-cover";

/**
 * Generated covers.
 *
 * The properties that matter are the ones a reader would notice going wrong:
 * the same post must keep the same cover between builds, the brand square must
 * appear exactly once, its hue must never collide with the brand cyan, and the
 * markup must stay small enough to carry one per list row.
 */

const SHAPES: readonly CoverShape[] = ["tile", "band", "header", "card"];

describe("generated covers", () => {
  it("draws the same cover for the same seed", () => {
    for (const shape of SHAPES) {
      expect(generatedCoverSvg("notes/first-note", shape)).toBe(
        generatedCoverSvg("notes/first-note", shape),
      );
    }
  });

  it("draws different covers for different posts", () => {
    expect(generatedCoverSvg("a", "band")).not.toBe(
      generatedCoverSvg("b", "band"),
    );
  });

  it("contains exactly one brand square", () => {
    for (const shape of SHAPES) {
      const svg = generatedCoverSvg("dev/web/deep/nested", shape);
      expect(svg.match(/generated-cover__find/g)).toHaveLength(1);
    }
  });

  it("keeps the hue out of the brand cyan's neighbourhood", () => {
    for (let index = 0; index < 500; index += 1) {
      const hue = coverHue(`post-${String(index)}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      // Brand cyan sits near 190°; the generator skips 160°–219°.
      expect(hue >= 160 && hue < 220).toBe(false);
    }
  });

  it("writes nothing from the seed into the markup", () => {
    const svg = generatedCoverSvg('"><script>alert(1)</script>', "tile");
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("alert");
  });

  it("stays small enough to carry one per list row", () => {
    for (const shape of ["tile", "band"] as const) {
      for (let index = 0; index < 50; index += 1) {
        expect(
          generatedCoverSvg(`post-${String(index)}`, shape).length,
        ).toBeLessThan(4000);
      }
    }
  });

  it("keeps the article shapes, which a page carries both of, in bounds", () => {
    for (const shape of ["header", "card"] as const) {
      for (let index = 0; index < 50; index += 1) {
        expect(
          generatedCoverSvg(`post-${String(index)}`, shape).length,
        ).toBeLessThan(14_000);
      }
    }
  });

  it("is hidden from assistive technology", () => {
    expect(generatedCoverSvg("x", "card")).toContain('aria-hidden="true"');
  });
});
