import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { describe, expect, it } from "vitest";

import { rehypeMermaid } from "../../src/lib/markdown/rehype-mermaid";

/**
 * Render a Markdown fragment through the Mermaid transform.
 *
 * The `mermaid` fenced block is left untouched by Shiki (it is in the excluded
 * language list), so a plain parse is enough to reach the plugin in the same
 * shape the real pipeline produces.
 */
async function render(markdown: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeMermaid)
    .use(rehypeStringify);

  return String(await processor.process(markdown));
}

describe("rehypeMermaid — the diagram holder", () => {
  it("turns a mermaid fence into a figure with a labelled drawing area", async () => {
    const html = await render("```mermaid\ngraph TD;\n  A --> B;\n```\n");

    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain("data-mermaid");
    // The drawing area is an image, so it must carry a name.
    expect(html).toMatch(/role="img"[^>]*aria-label="[^"]+"/u);
  });

  it("names the diagram after its own directive", async () => {
    const html = await render(
      "```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n",
    );
    expect(html).toContain('aria-label="图表：时序图"');
  });

  it("falls back to a generic name for an unrecognised directive", async () => {
    const html = await render("```mermaid\nsomethingNew\n  A --> B\n```\n");
    expect(html).toContain('aria-label="图表"');
  });

  it("still names an empty diagram block", async () => {
    // An unlabelled `role="img"` is the violation this guards against, so the
    // degenerate input must not produce one either.
    const html = await render("```mermaid\n```\n");
    expect(html).toMatch(/role="img"[^>]*aria-label="[^"]+"/u);
  });

  it("keeps the source visible for the no-JavaScript case", async () => {
    const html = await render("```mermaid\ngraph TD;\n  A --> B;\n```\n");
    expect(html).toContain("mermaid-block__source");
    expect(html).toContain("graph TD;");
  });

  it("leaves a non-mermaid fence alone", async () => {
    const html = await render("```js\nconst a = 1;\n```\n");
    expect(html).not.toContain("mermaid-block");
  });
});
