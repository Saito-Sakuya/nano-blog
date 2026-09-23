import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { PROJECT_ROOT } from "../../src/lib/content/paths";
import { FIXTURE_SENTINEL, scanForLeaks } from "../../scripts/build/postbuild";

/**
 * Checks made against the real built output rather than against a function.
 *
 * Everything here reads files that `pnpm build:fixtures` actually produced, so
 * a passing assertion means the artefact on disk is correct — not that a helper
 * would return the right value if it were called.
 *
 * These tests are skipped when the build is absent, and say so, rather than
 * failing for a reason that has nothing to do with the code.
 */

const FIXTURES = path.join(PROJECT_ROOT, "dist-fixtures");
const NORMAL = path.join(PROJECT_ROOT, "dist");
const built = existsSync(path.join(FIXTURES, "index.html"));

beforeAll(() => {
  if (!built) {
    console.warn(
      "integration: dist-fixtures is missing — run `pnpm build:fixtures` first. Skipping artefact checks.",
    );
  }
});

function read(relative: string): string {
  return readFileSync(path.join(FIXTURES, relative), "utf8");
}

describe.skipIf(!built)("feed", () => {
  it("is well-formed XML with the expected channel", () => {
    const feed = read("rss.xml");
    expect(feed.startsWith("<?xml")).toBe(true);
    expect(feed).toContain("<rss");
    expect(feed).toContain("<language>zh-CN</language>");
    expect(feed).toContain("https://creativecommons.org/licenses/by/4.0/");
  });

  it("carries full article HTML rather than a teaser", () => {
    // `content:encoded` escapes its payload, so the markup to look for is the
    // escaped form; the table text alone would also match a description.
    const feed = read("rss.xml");
    expect(feed).toContain("TEST FIXTURE 第一条脚注");
    expect(feed).toContain("&lt;table&gt;");
    expect(feed).toContain("&lt;h2&gt;");
  });

  it("documents the known MDX gap rather than hiding it", () => {
    /*
     * `.mdx` documents have no `rendered.html`, so their feed items carry the
     * metadata and the cover but no body. This test pins the current behaviour
     * so the gap cannot be mistaken for working full-text output: when the gap
     * is closed, this test fails and should be deleted.
     */
    const feed = read("rss.xml");
    expect(feed).toContain("TEST FIXTURE MDX 白名单组件示例");
    expect(feed).not.toContain("gallery");
  });

  it("absolutises every URL", () => {
    const feed = read("rss.xml");
    const relative = [...feed.matchAll(/(?:href|src)="(\/[^"]*)"/gu)].map(
      (match) => match[1],
    );
    expect(
      relative,
      `relative URLs in the feed: ${relative.slice(0, 5).join(", ")}`,
    ).toEqual([]);
  });

  it("contains no iframe or script-dependent shell", () => {
    const feed = read("rss.xml");
    // Both the raw and the escaped form of an embedding element.
    expect(feed.toLowerCase()).not.toContain("<iframe");
    expect(feed.toLowerCase()).not.toContain("&lt;iframe");
    expect(feed.toLowerCase()).not.toContain("<script");
    expect(feed.toLowerCase()).not.toContain("&lt;script");
  });

  it("excludes drafts and future-dated articles", () => {
    const feed = read("rss.xml");
    expect(feed).not.toContain("草稿");
    expect(feed).not.toContain("未来文章");
  });
});

describe.skipIf(!built)("sitemap", () => {
  it("is an index pointing at one or more sitemaps", () => {
    const index = read("sitemap-index.xml");
    expect(index).toContain("<sitemapindex");
    expect(index).toMatch(/sitemap-0\.xml/u);
  });

  it("lists public canonical URLs and nothing else", () => {
    const sitemap = read("sitemap-0.xml");
    expect(sitemap).toContain(
      "https://blog.example.invalid/posts/notes/first-note/",
    );
    expect(sitemap).not.toContain("draft-post");
    expect(sitemap).not.toContain("future-post");
    expect(sitemap).not.toContain("404");
    // The leak-sentinel post is a legitimate fixture article, so it belongs in
    // the *fixture* sitemap. What must never contain it is the real build,
    // which the fixture-isolation block below checks.
    // Page one is `/`, never `/page/1/`.
    expect(sitemap).not.toContain("/page/1/");
  });
});

describe.skipIf(!built)("article document", () => {
  const article = "posts/notes/first-note/index.html";

  it("carries valid BlogPosting structured data", () => {
    const html = read(article);
    const match =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html);
    expect(match, "no JSON-LD block found").not.toBeNull();

    // Parsed as JSON, so a malformed block fails here rather than in a crawler.
    const parsed = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(parsed["@type"]).toBe("BlogPosting");
    expect(parsed["headline"]).toBeTruthy();
    expect(parsed["datePublished"]).toBeTruthy();
    expect(parsed["inLanguage"]).toBe("zh-CN");
    expect(parsed["isAccessibleForFree"]).toBe(true);
    expect(parsed["license"]).toBe(
      "https://creativecommons.org/licenses/by/4.0/",
    );

    const author = parsed["author"] as Record<string, unknown>;
    expect(author["@type"]).toBe("Person");
    expect(author["name"]).toBe("Nano");
    // No invented identity: no URL, no job title, no avatar.
    expect(author["url"]).toBeUndefined();
    expect(author["jobTitle"]).toBeUndefined();
    expect(author["image"]).toBeUndefined();
  });

  it("points og:image at a card that exists in the build", () => {
    const html = read(article);
    const ogImage = /property="og:image" content="([^"]+)"/u.exec(html)?.[1];
    expect(ogImage).toBeTruthy();

    const ogPath = new URL(ogImage!).pathname;
    const file = path.join(FIXTURES, ogPath);
    expect(existsSync(file), `missing OG card: ${ogPath}`).toBe(true);
  });

  it("declares a canonical URL on the real origin", () => {
    const html = read(article);
    expect(html).toContain(
      '<link rel="canonical" href="https://blog.example.invalid/posts/notes/first-note/">',
    );
  });

  it("does not preconnect to the unconfigured media placeholder", () => {
    const html = read(article);
    expect(html).not.toContain(
      '<link rel="preconnect" href="https://media.example.invalid"',
    );
  });
});

describe.skipIf(!built)("security headers", () => {
  const REQUIRED: readonly [string, string][] = [
    ["Content-Security-Policy", "default-src 'self'"],
    ["Content-Security-Policy", "object-src 'none'"],
    ["Content-Security-Policy", "frame-ancestors 'none'"],
    ["Content-Security-Policy", "script-src 'self'"],
    ["Content-Security-Policy", "font-src 'self'"],
    [
      "Content-Security-Policy",
      "frame-src https://www.youtube-nocookie.com https://player.bilibili.com",
    ],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ];

  it("contains every required directive", () => {
    const headers = read("_headers");
    for (const [name, fragment] of REQUIRED) {
      expect(headers, `${name} missing ${fragment}`).toContain(fragment);
    }
  });

  it("never weakens the script policy", () => {
    const headers = read("_headers");
    expect(headers).not.toContain("script-src 'unsafe-inline'");
    expect(headers).not.toContain("script-src 'unsafe-eval'");
    expect(headers).not.toMatch(/script-src[^;]*https:/u);
  });

  it("binds the configured media origin into both CSP directives", () => {
    const headers = read("_headers");
    expect(headers.match(/https:\/\/media\.example\.invalid/gu)).toHaveLength(
      2,
    );
  });

  it("keeps a noindex rule out of the version-controlled source", () => {
    const source = readFileSync(
      path.join(PROJECT_ROOT, "public", "_headers"),
      "utf8",
    );
    // The phrase appears in a comment; what must not appear is a header line.
    expect(source).not.toMatch(/^\s*X-Robots-Tag:/mu);
    expect(read("_headers")).toMatch(/^\s*X-Robots-Tag:\s*noindex, nofollow/mu);
  });
});

describe.skipIf(!built)("fixture isolation", () => {
  it("the fixture build really does carry the sentinel", async () => {
    const report = await scanForLeaks(FIXTURES);
    expect(
      report.sentinelPresent,
      `${FIXTURE_SENTINEL} missing from the fixture build`,
    ).toBe(true);
  });

  it.runIf(existsSync(path.join(NORMAL, "index.html")))(
    "the normal build carries no trace of it",
    async () => {
      const report = await scanForLeaks(NORMAL);
      expect(report.sentinelPresent).toBe(false);
      expect(report.leaks, JSON.stringify(report.leaks.slice(0, 5))).toEqual(
        [],
      );
    },
  );
});
