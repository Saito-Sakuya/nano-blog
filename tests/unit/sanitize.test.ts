import { unified } from "unified";
import remarkParse from "remark-parse";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { describe, expect, it, vi } from "vitest";
import type * as HastFromHtml from "hast-util-from-html";

import { remarkSanitizeHtml } from "../../src/lib/markdown/remark-sanitize-html";
import {
  classifyAuthorUrl,
  isSafeAuthorUrl,
} from "../../src/lib/markdown/sanitize-schema";

/**
 * A parser that fails on demand.
 *
 * `hast-util-from-html` is deliberately tolerant, so the one input the
 * sanitiser cannot handle — and therefore the input its failure behaviour must
 * be tested with — can only be produced by making the parser throw.
 */
vi.mock("hast-util-from-html", async (importOriginal) => {
  const actual = await importOriginal<typeof HastFromHtml>();
  return {
    ...actual,
    fromHtml: (
      html: string,
      options?: Parameters<typeof actual.fromHtml>[1],
    ) => {
      if (html.includes("SANITIZER_PARSE_FAILURE")) {
        throw new Error("simulated parse failure");
      }
      return actual.fromHtml(html, options);
    },
  };
});

/**
 * Render a Markdown fragment through the project's own author-HTML sanitiser.
 */
async function render(markdown: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkSanitizeHtml)
    .use(remarkRehype, { allowDangerousHtml: true })
    // `rehypeRaw` would parse the sanitised string back into elements in the
    // real pipeline; stringifying it directly is enough to inspect the result.
    .use(rehypeStringify, { allowDangerousHtml: true });

  return String(await processor.process(markdown));
}

describe("author HTML sanitiser — removals", () => {
  it("removes a script element and its contents", async () => {
    const html = await render(
      "<div>before<script>alert(1)</script>after</div>",
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert");
  });

  it("removes event-handler attributes", async () => {
    const html = await render('<div onclick="steal()">text</div>');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("steal");
  });

  it("removes style attributes", async () => {
    const html = await render('<div style="position:fixed;inset:0">text</div>');
    expect(html).not.toContain("style");
    expect(html).not.toContain("position");
  });

  it("removes author-supplied class, id and data attributes", async () => {
    const html = await render('<div class="x" id="y" data-z="w">text</div>');
    expect(html).not.toContain("class");
    expect(html).not.toContain("id=");
    expect(html).not.toContain("data-z");
  });

  it("removes iframes, objects, embeds and forms", async () => {
    for (const markup of [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x" />',
      '<form action="/x"><input /></form>',
    ]) {
      const html = await render(markup);
      expect(html).not.toMatch(/iframe|object|embed|form/iu);
    }
  });

  it("removes SVG and MathML written by the author", async () => {
    const html = await render(
      '<svg><circle r="1" /></svg><math><mi>x</mi></math>',
    );
    expect(html).not.toContain("svg");
    expect(html).not.toContain("math");
  });

  it("removes a table element that is not permitted", async () => {
    const html = await render("<caption>nope</caption>");
    expect(html).not.toContain("caption");
  });
});

describe("author HTML sanitiser — URL handling", () => {
  it("drops a javascript: href", async () => {
    const html = await render('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("drops a data: href", async () => {
    const html = await render(
      '<a href="data:text/html,<script>alert(1)</script>">click</a>',
    );
    expect(html).not.toContain("data:");
  });

  it("drops a protocol-relative href", async () => {
    const html = await render('<a href="//evil.example/x">click</a>');
    expect(html).not.toContain("//evil.example");
  });

  it("drops a vbscript: href", async () => {
    const html = await render('<a href="vbscript:msgbox(1)">click</a>');
    expect(html).not.toContain("vbscript");
  });

  it("keeps https, mailto and site-absolute hrefs", async () => {
    expect(await render('<a href="https://example.invalid/x">a</a>')).toContain(
      "https://example.invalid/x",
    );
    expect(await render('<a href="mailto:a@example.invalid">a</a>')).toContain(
      "mailto:a@example.invalid",
    );
    expect(await render('<a href="/posts/">a</a>')).toContain('href="/posts/"');
  });
});

describe("author HTML sanitiser — permitted markup", () => {
  it("keeps the allowed inline elements", async () => {
    const html = await render(
      "<p><strong>bold</strong> <em>italic</em> <del>gone</del> <kbd>Ctrl</kbd> <mark>hi</mark> H<sub>2</sub>O x<sup>2</sup></p>",
    );
    for (const tag of ["strong", "em", "del", "kbd", "mark", "sub", "sup"]) {
      expect(html).toContain(`<${tag}>`);
    }
  });

  it("keeps abbr with its title", async () => {
    const html = await render('<abbr title="HyperText">HTML</abbr>');
    expect(html).toContain('<abbr title="HyperText">');
  });

  it("keeps details and summary", async () => {
    const html = await render("<details><summary>more</summary>body</details>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
  });

  it("keeps an image with size and lazy-loading hints", async () => {
    const html = await render(
      '<img src="/media/a/1600.webp" alt="x" width="100" height="50" loading="lazy" decoding="async" />',
    );
    expect(html).toContain('src="/media/a/1600.webp"');
    expect(html).toContain('loading="lazy"');
  });

  it("drops an author-set class on a code element", async () => {
    // Shiki adds its own classes later; an author cannot forge them.
    const html = await render('<code class="astro-code">x</code>');
    expect(html).not.toContain("class");
  });
});

describe("author HTML sanitiser — a fragment that cannot be parsed", () => {
  it("drops the node rather than passing the original through", async () => {
    /*
     * Fail closed. This used to keep `node.value` untouched when the fragment
     * could not be parsed, which meant the one input the sanitiser could not
     * handle was also the one input it forwarded to the renderer unvetted.
     */
    const html = await render(
      [
        "Before text.",
        "",
        "<div>SANITIZER_PARSE_FAILURE <b>kept?</b></div>",
        "",
        "After text.",
        "",
      ].join("\n"),
    );

    expect(html).not.toContain("SANITIZER_PARSE_FAILURE");
    expect(html).not.toContain("kept?");
    // Only the unparsable block is dropped: the prose around it survives.
    expect(html).toContain("Before text.");
    expect(html).toContain("After text.");
  });
});

describe("isSafeAuthorUrl", () => {
  it("accepts https, http, mailto and site-absolute paths", () => {
    for (const url of [
      "https://example.invalid/x",
      "http://example.invalid/x",
      "mailto:a@example.invalid",
      "/posts/",
      "#section",
      "relative/path",
    ]) {
      expect(isSafeAuthorUrl(url)).toBe(true);
    }
  });

  it("rejects dangerous and ambiguous URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
      "blob:https://x/y",
      "//evil.example/x",
      "  ",
      "",
    ]) {
      expect(isSafeAuthorUrl(url)).toBe(false);
    }
  });

  it("rejects the spellings a browser reads as protocol-relative", () => {
    /*
     * The WHATWG parser treats `\` as `/` for special schemes and removes tab,
     * LF and CR before parsing. So all of these resolve to
     * `https://evil.example/…` while looking like site-absolute paths — the
     * `startsWith("//")` test this replaced caught only the first spelling.
     */
    for (const url of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example",
      "/\n/evil.example",
      "\\\\evil.example/x",
      "/\\/evil.example/x",
    ]) {
      expect(isSafeAuthorUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it("rejects a scheme smuggled past the parser with a control character", () => {
    // `java\tscript:` is `javascript:` once the tab is removed.
    expect(isSafeAuthorUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeAuthorUrl("\u0000javascript:alert(1)")).toBe(false);
  });
});

describe("classifyAuthorUrl", () => {
  it("names the shape of each accepted URL", () => {
    expect(classifyAuthorUrl("https://example.invalid/x")).toBe("https");
    expect(classifyAuthorUrl("http://example.invalid/x")).toBe("http");
    expect(classifyAuthorUrl("mailto:a@example.invalid")).toBe("mailto");
    expect(classifyAuthorUrl("/posts/")).toBe("site");
    expect(classifyAuthorUrl("relative/path")).toBe("relative");
    expect(classifyAuthorUrl("#section")).toBe("fragment");
  });

  it("calls everything else unsafe", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,x",
      "//evil.example/x",
      "/\\evil.example/x",
      "  ",
    ]) {
      expect(classifyAuthorUrl(url), url).toBe("unsafe");
    }
  });

  it("does not let a hostile `SITE_URL` widen what is accepted", () => {
    // The site origin comes from configuration; a relative URL is only safe
    // because it stays on that origin. Nothing here depends on the *value*.
    expect(classifyAuthorUrl("/posts/")).toBe("site");
    expect(classifyAuthorUrl("https://example.invalid/x")).toBe("https");
  });
});
