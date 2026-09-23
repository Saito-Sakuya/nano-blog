import { describe, expect, it } from "vitest";

import {
  blogJsonLd,
  blogPostingJsonLd,
  serializeJsonLd,
} from "../../src/lib/seo/jsonld";
import type { PostFrontmatter } from "../../src/lib/content/schema";

/**
 * The JSON-LD payload and the one thing that makes it safe to inline.
 *
 * The payload is written into `<head>` with `set:html`, so its text is parsed by
 * the HTML parser before any JSON parser sees it. These tests pin the escaping
 * that keeps the two parsers agreeing: a `</script` inside a title must not be
 * able to end the element.
 */

/** The exact payload the review used to demonstrate the injection. */
const INJECTION =
  '</script><meta http-equiv="refresh" content="0;url=//evil.example">';

function frontmatter(overrides: Partial<PostFrontmatter>): PostFrontmatter {
  return {
    title: "一篇测试文章",
    description: "描述",
    publishedAt: "2026-01-01T00:00:00+08:00",
    draft: false,
    lang: "zh-CN",
    tags: [],
    comments: true,
    toc: "auto",
    ...overrides,
  } as PostFrontmatter;
}

describe("serializeJsonLd", () => {
  it("escapes every character that can matter to the HTML or script parser", () => {
    const serialised = serializeJsonLd({ value: "<&>\u2028\u2029" });

    expect(serialised).toBe('{"value":"\\u003c\\u0026\\u003e\\u2028\\u2029"}');
    // Nothing raw is left for the HTML tokenizer to act on.
    expect(serialised).not.toContain("<");
    expect(serialised).not.toContain(">");
    expect(serialised).not.toContain("&");
  });

  it("keeps a closing tag in a title out of the document", () => {
    const serialised = serializeJsonLd({ headline: INJECTION });

    expect(serialised).not.toContain("</script");
    expect(serialised).not.toContain("<meta");
    expect(serialised).toContain("\\u003c/script\\u003e");
  });

  it("round-trips through a JSON parser unchanged", () => {
    const payload = {
      headline: INJECTION,
      description: "数学 < 与 > 比较, & 号, 段落分隔\u2028符",
      keywords: ["<b>", "a&b"],
    };

    expect(JSON.parse(serializeJsonLd(payload))).toEqual(payload);
  });

  it("escapes nested values, not just top-level strings", () => {
    const serialised = serializeJsonLd({
      author: { "@type": "Person", name: "<Nano>" },
      keywords: ["a<b"],
    });

    expect(serialised).not.toContain("<");
    expect(JSON.parse(serialised)).toEqual({
      author: { "@type": "Person", name: "<Nano>" },
      keywords: ["a<b"],
    });
  });
});

describe("blogPostingJsonLd — escaping a real payload", () => {
  it("cannot break out of the script element through the headline", () => {
    const json = blogPostingJsonLd({
      data: frontmatter({ title: INJECTION }),
      id: "notes/example",
      url: "/posts/notes/example/",
      description: "描述",
      imageUrl: "https://media.example/cover.webp",
    });

    const serialised = serializeJsonLd(json);
    expect(serialised).not.toMatch(/<\/script/iu);
    expect(serialised).not.toContain("<meta");
    // The title really is in there; it is the markup that is neutralised.
    expect(JSON.parse(serialised)).toMatchObject({ headline: INJECTION });
  });

  it("never ships a head that a raw `</script>` could close", () => {
    // Belt and braces: the same check over the whole document-level payload.
    const serialised = serializeJsonLd(blogJsonLd());
    expect(serialised).not.toContain("</");
  });
});
