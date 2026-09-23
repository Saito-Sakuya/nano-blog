import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OG_DEFAULT_CARD_PATH,
  OG_DEFAULT_KEY,
  OG_HEIGHT,
  OG_WIDTH,
  SITE_LANG,
  SITE_OG_LOCALE,
  canonicalUrl,
  ogCardPath,
} from "../../src/lib/site";
import {
  OG_HEIGHT as CARD_OG_HEIGHT,
  OG_WIDTH as CARD_OG_WIDTH,
  ogImagePath,
} from "../../src/lib/seo/og";
import { buildMetadata } from "../../src/lib/seo/metadata";

/**
 * One source for the values that have to agree.
 *
 * The language tag, the author's name, the time zone, the feed path, the two
 * API endpoints and the Open Graph card's size were each written more than once,
 * in files that never import each other — six spellings of the language, three
 * of the author, two of the card size. Nothing catches that class of duplicate:
 * each copy is valid, the site builds, and the divergence only shows up as a
 * feed in one language and a page in another.
 *
 * The first half of this file asserts the values are derived from each other.
 * The second half asserts the literals are *gone* from the files that used to
 * carry them, because a duplicate that has been removed is only removed until
 * somebody types it again, and the derived-value assertions cannot see a literal
 * that nothing reads.
 */

function source(relativePath: string): string {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

describe("derived site constants", () => {
  it("spells og:locale from the one language tag", () => {
    expect(SITE_OG_LOCALE).toBe("zh_CN");
    expect(SITE_OG_LOCALE).toBe(SITE_LANG.replace("-", "_"));
  });

  it("names the fallback card from its key", () => {
    expect(OG_DEFAULT_KEY).toBe("default");
    expect(OG_DEFAULT_CARD_PATH).toBe(ogCardPath(OG_DEFAULT_KEY));
    expect(OG_DEFAULT_CARD_PATH).toBe("/og/default.png");
  });

  it("declares the same card size the generator draws at", () => {
    // The card module re-exports these, so a page can ask the generator for a
    // path and the metadata for a size without the two numbers ever being
    // written twice.
    expect(CARD_OG_WIDTH).toBe(OG_WIDTH);
    expect(CARD_OG_HEIGHT).toBe(OG_HEIGHT);
  });

  it("uses the fallback card, at the right size, in page metadata", () => {
    const meta = buildMetadata({
      title: "测试",
      description: "描述",
      pathname: "/posts/notes/example/",
    });

    expect(meta.ogImage).toBe(canonicalUrl(OG_DEFAULT_CARD_PATH));
    expect(meta.ogImageWidth).toBe(OG_WIDTH);
    expect(meta.ogImageHeight).toBe(OG_HEIGHT);
  });

  it("keeps the card path helper and the metadata default in agreement", () => {
    expect(ogImagePath(undefined)).toBe(OG_DEFAULT_CARD_PATH);
  });
});

/**
 * A literal that must not come back.
 *
 * The patterns are narrow on purpose: this is a guard against a specific value
 * being written a second time, not a style rule about string constants.
 */
const FORBIDDEN_LITERALS: readonly {
  readonly file: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  {
    file: "src/layouts/BaseLayout.astro",
    pattern: /zh-CN/u,
    why: "the document language comes from SITE_LANG",
  },
  {
    file: "src/components/SeoHead.astro",
    pattern: /zh[-_]CN/u,
    why: "og:locale comes from SITE_OG_LOCALE",
  },
  {
    file: "src/components/SeoHead.astro",
    pattern: /nano-blog/u,
    why: "the site name comes from SITE_NAME",
  },
  {
    file: "src/components/SeoHead.astro",
    pattern: /["']\/rss\.xml["']/u,
    why: "the feed path comes from rssUrl",
  },
  {
    file: "src/components/SiteFooter.astro",
    pattern: /Asia\/Taipei/u,
    why: "the time zone comes from SITE_TIME_ZONE",
  },
  {
    file: "src/components/SiteFooter.astro",
    pattern: /\bAni\b/u,
    why: "the author's name comes from SITE_AUTHOR",
  },
  {
    file: "src/components/SiteFooter.astro",
    pattern: /["']\/rss\.xml["']/u,
    why: "the feed path comes from rssUrl",
  },
  {
    file: "src/lib/seo/jsonld.ts",
    pattern: /zh-CN/u,
    why: "the language comes from SITE_LANG",
  },
  {
    file: "src/lib/seo/jsonld.ts",
    pattern: /name: "Nano"/u,
    why: "the author's name comes from SITE_AUTHOR",
  },
  {
    file: "src/lib/seo/metadata.ts",
    pattern: /\/og\/default\.png/u,
    why: "the fallback card path comes from OG_DEFAULT_CARD_PATH",
  },
  {
    file: "src/lib/seo/metadata.ts",
    pattern: /=\s*(?:1200|630)\b/u,
    why: "the card size comes from OG_WIDTH / OG_HEIGHT",
  },
  {
    file: "src/lib/seo/og.ts",
    pattern: /=\s*(?:1200|630)\b/u,
    why: "the card size comes from OG_WIDTH / OG_HEIGHT",
  },
  {
    file: "src/scripts/views.ts",
    pattern: /["'`]\/api\/views\//u,
    why: "the endpoint comes from viewsApiPath",
  },
  {
    file: "src/scripts/views.ts",
    pattern: /zh-CN/u,
    why: "the locale comes from SITE_LANG",
  },
  {
    file: "src/scripts/comments.ts",
    pattern: /["'`]\/api\/comments\//u,
    why: "the endpoint comes from commentsApiPath",
  },
  {
    file: "src/scripts/comments.ts",
    pattern: /zh-CN/u,
    why: "the locale comes from SITE_LANG",
  },
];

describe("no second copy of a shared value", () => {
  it.each(FORBIDDEN_LITERALS)(
    "$file does not spell $pattern again ($why)",
    ({ file, pattern }) => {
      expect(source(file)).not.toMatch(pattern);
    },
  );
});
