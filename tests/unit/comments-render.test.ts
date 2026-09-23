import { fromHtml } from "hast-util-from-html";
import { describe, expect, it } from "vitest";

import { renderCommentMarkdown } from "../../src/lib/comments/render";

/**
 * The comment renderer, tested adversarially.
 *
 * Every case below is something a stranger can type into the comment box. The
 * suite is written as "this must not survive" rather than "this should become
 * that", because that is the direction the risk runs in: a formatting feature
 * that regresses is a cosmetic bug, and an escaping hole that regresses is an
 * executed script in every reader's browser.
 *
 * The assertions look at the produced HTML string for anything executable. They
 * deliberately do not check exact output for the ordinary formatting cases — a
 * change in how remark emits a paragraph should not fail a security test — only
 * that the safe subset keeps working.
 */

/*
 * The checks below parse the rendered HTML and inspect its tags and attributes,
 * rather than searching the output for suspicious substrings.
 *
 * That distinction is not pedantry. A comment that *discusses* an attack is
 * legal content: someone writing "`<img onerror=alert(1)>` is a classic XSS
 * payload" produces output in which the characters `onerror=` appear — as
 * escaped text, where they do nothing. A substring search fails that comment and
 * passes a genuinely dangerous one whose payload happens to be spelled with an
 * entity. Parsing asks the only question that matters: did the browser receive
 * markup it will act on?
 */

/** Tag names that must never reach the DOM from a comment. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "style",
  "link",
  "meta",
  "base",
  "svg",
  "math",
  "img",
  "video",
  "audio",
  "canvas",
  "template",
  "applet",
  "frame",
  "frameset",
]);

/** URL schemes that must never appear in an attribute the browser will fetch. */
const FORBIDDEN_SCHEMES = /^(?:javascript|data|vbscript|file|blob):/iu;

interface Inspected {
  readonly tags: string[];
  readonly attributes: { tag: string; name: string; value: string }[];
}

/** Parse rendered HTML and collect the tags and attributes it actually contains. */
function inspect(html: string): Inspected {
  const tree = fromHtml(html);
  const tags: string[] = [];
  const attributes: { tag: string; name: string; value: string }[] = [];

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const element = node as {
      type?: string;
      tagName?: string;
      properties?: Record<string, unknown>;
      children?: unknown[];
    };

    if (element.type === "element" && typeof element.tagName === "string") {
      tags.push(element.tagName);
      for (const [name, value] of Object.entries(element.properties ?? {})) {
        if (typeof value === "string") {
          attributes.push({ tag: element.tagName, name, value });
        }
      }
    }

    if (Array.isArray(element.children)) {
      for (const child of element.children) walk(child);
    }
  };

  walk(tree);
  return { tags, attributes };
}

/**
 * Assert that rendered output contains no markup a browser would act on.
 *
 * Checks three things, and only these three: no forbidden element, no inline
 * event handler, and no attribute whose value carries a dangerous scheme.
 */
function expectClean(html: string, label: string): void {
  const { tags, attributes } = inspect(html);

  for (const tag of tags) {
    expect(
      FORBIDDEN_TAGS.has(tag.toLowerCase()),
      `${label}: rendered a <${tag}> element`,
    ).toBe(false);
  }

  for (const { tag, name, value } of attributes) {
    expect(
      /^on/iu.test(name),
      `${label}: <${tag}> carries the event handler ${name}="${value}"`,
    ).toBe(false);

    if (name === "href" || name === "src" || name === "cite") {
      const flattened = value.replace(/[\u0000-\u0020]/gu, "");
      expect(
        FORBIDDEN_SCHEMES.test(flattened) || flattened.startsWith("//"),
        `${label}: <${tag}> ${name}="${value}" is a forbidden destination`,
      ).toBe(false);
    }
  }
}

describe("renderCommentMarkdown — ordinary formatting still works", () => {
  it("renders emphasis, strong and inline code", () => {
    const html = renderCommentMarkdown(
      "This is *italic*, **bold** and `code`.",
    );
    expect(html).toContain("<em>");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
  });

  it("renders lists and blockquotes", () => {
    expect(renderCommentMarkdown("- one\n- two")).toContain("<ul>");
    expect(renderCommentMarkdown("1. one\n2. two")).toContain("<ol>");
    expect(renderCommentMarkdown("> quoted")).toContain("<blockquote>");
  });

  it("renders fenced code blocks without executing anything", () => {
    const html = renderCommentMarkdown("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("<pre>");
    // The script is displayed rather than parsed. Both `&lt;` and `&#x3C;` are
    // valid spellings of the same escape, so the assertion is that no tag was
    // produced, not which entity the serialiser chose.
    expect(html).toContain("script");
    expectClean(html, "fenced code");
  });

  it("renders GFM tables and strikethrough", () => {
    expect(renderCommentMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toContain(
      "<table>",
    );
    expect(renderCommentMarkdown("~~gone~~")).toContain("<del>");
  });

  it("keeps an ordinary https link, with the attributes it needs", () => {
    const html = renderCommentMarkdown("[example](https://example.invalid/x)");
    expect(html).toContain('href="https://example.invalid/x"');
  });
});

describe("renderCommentMarkdown — raw HTML is text, not markup", () => {
  it("shows a script tag as literal text rather than dropping it", () => {
    const html = renderCommentMarkdown(
      "before <script>alert(1)</script> after",
    );
    expectClean(html, "inline script");
    // The reader sees what they typed — and so does the next reader, which is
    // the point: silently deleting someone's words is worse than showing them.
    expect(html).toContain("script");
    expect(html).toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("keeps a generic type argument, which looks like a tag to the parser", () => {
    // On a technical blog this is ordinary prose, and an earlier version of the
    // renderer turned it into "Array is a type" by treating <string> as markup.
    const html = renderCommentMarkdown("Array<string> is a type");
    expect(html).toContain("Array");
    expect(html).toContain("string");
    expect(html).toContain("is a type");
    expectClean(html, "generic type argument");
  });

  it("keeps the text that followed a style element", () => {
    // The element is dropped from the DOM; the sentence around it is not.
    const html = renderCommentMarkdown("<style>x</style>hello");
    expectClean(html, "style prefix");
    expect(html).toContain("hello");
  });

  it("escapes an event-handler attribute", () => {
    const html = renderCommentMarkdown('<img src=x onerror="alert(1)">');
    expectClean(html, "img onerror");
  });

  it("escapes a javascript: link written as raw HTML", () => {
    const html = renderCommentMarkdown('<a href="javascript:alert(1)">x</a>');
    expectClean(html, "raw javascript link");
  });

  it("escapes an iframe, an svg and a form", () => {
    for (const payload of [
      '<iframe src="https://evil.example"></iframe>',
      "<svg><script>alert(1)</script></svg>",
      '<form action="https://evil.example"><input name="x"></form>',
    ]) {
      expectClean(renderCommentMarkdown(payload), payload.slice(0, 20));
    }
  });

  it("escapes a style element that would otherwise restyle the page", () => {
    const html = renderCommentMarkdown(
      "<style>body{display:none}</style>hello",
    );
    expectClean(html, "style element");
    expect(html).toContain("hello");
  });

  it("escapes an HTML comment, which can hide conditional markup", () => {
    expectClean(
      renderCommentMarkdown(
        "<!--[if IE]><script>alert(1)</script><![endif]-->",
      ),
      "conditional comment",
    );
  });
});

describe("renderCommentMarkdown — markdown link destinations", () => {
  /*
   * This is the group that matters most, and the reason a naive sanitiser
   * configuration is not enough. A markdown link's destination is turned into a
   * real href by remark-rehype before any sanitiser runs, so the check has to
   * happen on the resulting tree rather than on the markdown text.
   */
  const PAYLOADS: readonly (readonly [string, string])[] = [
    ["plain javascript:", "[x](javascript:alert(1))"],
    ["mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["leading whitespace", "[x](   javascript:alert(1))"],
    ["tab inside the scheme", "[x](java\tscript:alert(1))"],
    ["newline inside the scheme", "[x](java\nscript:alert(1))"],
    ["html entity", "[x](&#106;avascript:alert(1))"],
    [
      "data url",
      "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    ],
    ["vbscript", "[x](vbscript:msgbox(1))"],
    ["protocol relative", "[x](//evil.example/x)"],
    ["file scheme", "[x](file:///etc/passwd)"],
    ["blob scheme", "[x](blob:https://example.invalid/uuid)"],
    ["image with javascript", "![x](javascript:alert(1))"],
    ["autolink javascript", "<javascript:alert(1)>"],
  ];

  for (const [label, payload] of PAYLOADS) {
    it(`neutralises ${label}`, () => {
      const html = renderCommentMarkdown(payload);
      expectClean(html, label);
      // The link text survives so the comment is still readable; only the
      // destination is gone.
      expect(html).not.toContain('href="javascript');
      expect(html).not.toContain('href="data:');
      expect(html).not.toContain('href="vbscript:');
    });
  }

  it("keeps a link whose destination is an ordinary external URL", () => {
    // The negative control: if this failed, the fix above would be "strip all
    // links", which passes the security cases and destroys the feature.
    expect(
      renderCommentMarkdown("[ok](https://example.invalid/a?b=c#d)"),
    ).toContain("https://example.invalid/a?b=c#d");
  });

  it("keeps an ordinary relative link", () => {
    expect(renderCommentMarkdown("[home](/posts/)")).toContain(
      'href="/posts/"',
    );
  });
});

describe("renderCommentMarkdown — tracking and layout attacks", () => {
  it("removes a markdown image, which would report the reader's IP", () => {
    const html = renderCommentMarkdown(
      "![pixel](https://tracker.example/1x1.gif)",
    );
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("<img");
  });

  it("removes an image written as raw HTML", () => {
    expect(
      renderCommentMarkdown('<img src="https://tracker.example/p.gif">'),
    ).not.toContain("<img");
  });

  /*
   * Styling cannot be borrowed. Raw HTML is shown as text, so the attempt is
   * already inert; these assert the stronger property directly on the parsed
   * output, so they keep holding even if the pipeline one day permits some raw
   * HTML to survive.
   */
  it("produces no class or id attribute a comment could borrow", () => {
    for (const payload of [
      '<p class="article-cover" id="main">x</p>',
      '<div class="wrap"><a class="bookmark" href="/">y</a></div>',
    ]) {
      const { attributes } = inspect(renderCommentMarkdown(payload));
      expect(
        attributes.filter((a) => a.name === "class" || a.name === "id"),
        payload,
      ).toEqual([]);
    }
  });

  it("produces no style attribute", () => {
    for (const payload of [
      '<p style="position:fixed">x</p>',
      '<span style="background:url(javascript:alert(1))">y</span>',
    ]) {
      const { attributes } = inspect(renderCommentMarkdown(payload));
      expect(
        attributes.filter((a) => a.name === "style"),
        payload,
      ).toEqual([]);
    }
  });
});

describe("renderCommentMarkdown — nothing in, nothing out", () => {
  it("renders an empty comment as an empty string", () => {
    expect(renderCommentMarkdown("").trim()).toBe("");
  });

  it("renders whitespace as an empty string", () => {
    expect(renderCommentMarkdown("   \n\t  ").trim()).toBe("");
  });

  it("does not throw on pathological input", () => {
    for (const payload of [
      "[".repeat(2000),
      "<".repeat(2000),
      "*".repeat(2000),
      "`".repeat(999),
      "\u0000\u0001\u0002",
      "a".repeat(10000),
    ]) {
      expect(() => renderCommentMarkdown(payload)).not.toThrow();
    }
  });

  it("never throws, and never emits a script tag, for a corpus of payloads", () => {
    const corpus = [
      "<script src=//evil.example/x.js></script>",
      "<IMG SRC=\"javascript:alert('XSS');\">",
      "<body onload=alert(1)>",
      '<div style="background:url(javascript:alert(1))">',
      '"><script>alert(1)</script>',
      "\\<script\\>alert(1)\\<\\/script\\>",
      '<a href="javas&#99;ript:alert(1)">x</a>',
      "<script/x>alert(1)</script>",
      "<scr<script>ipt>alert(1)</scr</script>ipt>",
      "javascript:alert(1)",
      "</textarea><script>alert(1)</script>",
    ];
    for (const payload of corpus) {
      const html = renderCommentMarkdown(payload);
      expectClean(html, payload.slice(0, 24));
    }
  });
});
