import { describe, expect, it } from "vitest";

import {
  bindMediaOrigin,
  MEDIA_ORIGIN_TEMPLATE,
} from "../../scripts/build/postbuild";

describe("bindMediaOrigin", () => {
  const source = `/*\n  Content-Security-Policy: img-src 'self' ${MEDIA_ORIGIN_TEMPLATE} data:; media-src 'self' ${MEDIA_ORIGIN_TEMPLATE}\n`;

  it("uses the configured origin in both media directives", () => {
    const rendered = bindMediaOrigin(source, "https://cdn.example.com");
    expect(rendered).not.toContain(MEDIA_ORIGIN_TEMPLATE);
    expect(rendered.match(/https:\/\/cdn\.example\.com/gu)).toHaveLength(2);
  });

  it("fails closed when the template no longer has both placeholders", () => {
    expect(() =>
      bindMediaOrigin(
        `img-src ${MEDIA_ORIGIN_TEMPLATE}`,
        "https://cdn.example.com",
      ),
    ).toThrow(/exactly two/u);
  });
});
