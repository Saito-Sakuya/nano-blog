import { describe, expect, it } from "vitest";

import {
  ALLOWED_MDX_COMPONENTS,
  extractDocument,
} from "../../scripts/content/extract";

/**
 * Body extraction, which is what `content:validate` reads a file through.
 *
 * The two properties worth pinning are the ones that decide whether a release
 * is refused: heading ids must be the ids the renderer emits, and the MDX gate
 * must be the same one the rest of the build uses — including for the spellings
 * a case-sensitive scan misses.
 */

function extract(body: string, file = "posts/notes/a.md") {
  return extractDocument(body, { file, mdx: file.endsWith(".mdx") });
}

function slugs(body: string, file?: string): string[] {
  return extract(body, file).headings.map((heading) => heading.slug);
}

function problems(body: string, file?: string): string {
  return extract(body, file).problems.join(" | ");
}

describe("extractDocument — headings", () => {
  it("collects headings with their depth and text", () => {
    const document = extract("## One\n\n### Two\n");
    expect(document.headings.map((heading) => heading.depth)).toEqual([2, 3]);
    expect(document.headings.map((heading) => heading.text)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("emits the de-duplicated slug the renderer would emit", () => {
    // The slugger, not the base slug, is the id: `#a-2` exists only because the
    // second `## A` took it, and the third heading must not reuse it.
    expect(slugs("## A\n\n## A\n\n## A-2\n")).toEqual(["a", "a-2", "a-2-2"]);
  });

  it("derives a heading's text the way the renderer does", () => {
    // `remark-heading-anchors` slugs `mdast-util-to-string`'s output, so inline
    // markup must not change the id.
    expect(slugs("## A *strong* `code` word\n")).toEqual([
      "a-strong-code-word",
    ]);
    expect(slugs("## ![Alt text](x.png)\n")).toEqual(["alt-text"]);
  });

  it("records the H1 that the body may not contain", () => {
    expect(extract("# Title\n\n## Section\n").h1Lines).toEqual([1]);
  });

  it("hashes a heading that has no Latin slug", () => {
    expect(slugs("## 中文标题\n")[0]).toMatch(/^section-[0-9a-f]{8}$/u);
  });
});

describe("extractDocument — visible content", () => {
  it("is false only for a body with nothing in it", () => {
    expect(extract("").hasVisibleContent).toBe(false);
    expect(extract("\n\n").hasVisibleContent).toBe(false);
  });

  it("is true when there is prose, a link, an image or a fence", () => {
    expect(extract("Some text.\n").hasVisibleContent).toBe(true);
    expect(extract("[link](/posts/)\n").hasVisibleContent).toBe(true);
    expect(extract("![alt](/media/a/1600.webp)\n").hasVisibleContent).toBe(
      true,
    );
    expect(extract("```ts\nconst a = 1;\n```\n").hasVisibleContent).toBe(true);
  });

  it("collects links, media, fences and callouts", () => {
    const document = extract(
      [
        "[a](/posts/)",
        "",
        "![alt](/media/b/1600.webp)",
        "",
        '```ts title="x"',
        "const a = 1;",
        "```",
        "",
        "> [!NOTE]",
        "> text",
        "",
      ].join("\n"),
    );

    expect(document.links.map((link) => link.url)).toEqual(["/posts/"]);
    expect(document.media.map((image) => image.path)).toEqual([
      "/media/b/1600.webp",
    ]);
    expect(document.fences.map((fence) => fence.info)).toEqual([
      'ts title="x"',
    ]);
    expect(document.callouts.map((callout) => callout.type)).toEqual(["NOTE"]);
  });

  it("rejects a callout type that does not exist", () => {
    expect(problems("> [!DANGER]\n> text\n")).toMatch(/callout type/u);
  });

  it("rejects a malformed code fence", () => {
    expect(problems("```ts title=unquoted\nconst a = 1;\n```\n")).toMatch(
      /Code fence title must be double-quoted/u,
    );
  });
});

describe("extractDocument — the MDX gate", () => {
  const file = "posts/notes/a.mdx";

  it("accepts the whitelisted components and their props", () => {
    expect(
      problems(
        [
          '<Callout type="NOTE" title="t">body</Callout>',
          "",
          '<Figure src="/media/a/1600.webp" alt="x" sizes="50vw" />',
          "",
          '<Tabs label="t">',
          '  <Tab label="a">x</Tab>',
          '  <Tab label="b">y</Tab>',
          "</Tabs>",
          "",
        ].join("\n"),
        file,
      ),
    ).toBe("");
  });

  it("still accepts plain Markdown in an .mdx file", () => {
    expect(problems("## Section\n\nSome *text*.\n", file)).toBe("");
  });

  it("rejects an event handler whatever its case", () => {
    // The gate this replaced matched `/\bon[A-Z]/`, so `onclick=` — the spelling
    // a browser actually honours — went straight into the static HTML.
    for (const attribute of [
      'onclick="steal()"',
      'onClick="steal()"',
      'ONCLICK="steal()"',
      'onmouseover="steal()"',
    ]) {
      const body = `<Callout type="NOTE" ${attribute}>b</Callout>`;
      expect(problems(body, file), attribute).toMatch(/not allowed/u);
    }
  });

  it("rejects an inline style whatever its case", () => {
    for (const attribute of ['style="color:red"', 'STYLE="color:red"']) {
      const body = `<Callout type="NOTE" ${attribute}>b</Callout>`;
      expect(problems(body, file), attribute).toMatch(/not allowed/u);
    }
  });

  it("rejects a forbidden attribute on raw HTML as well as on components", () => {
    expect(problems('<div ONCLICK="x()">text</div>', file)).toMatch(
      /not allowed/u,
    );
    expect(problems('<span STYLE="color:red">text</span>', file)).toMatch(
      /not allowed/u,
    );
  });

  it("rejects a non-whitelisted component and a raw script tag", () => {
    expect(problems("<Script />", file)).toMatch(/not a whitelisted/u);
    expect(problems("<script>alert(1)</script>", file)).toMatch(
      /Raw <script> is not allowed/u,
    );
  });

  it("rejects module syntax and JavaScript expressions", () => {
    expect(problems("import a from 'b'\n\nText\n", file)).toMatch(
      /import and export/u,
    );
    expect(problems("Text {1 + 1} more\n", file)).toMatch(
      /expressions are not allowed/u,
    );
  });

  it("rejects spread props and a non-literal attribute value", () => {
    expect(problems("<Callout {...props}>b</Callout>", file)).toMatch(
      /Spread props/u,
    );
    expect(problems("<Figure src={dynamicValue} />", file)).toMatch(/literal/u);
  });

  it("does not report the same construct twice", () => {
    // One gate, not two: `inspectMdx` used to run alongside this one and every
    // rule was reported by both.
    const found = extract(
      '<Callout type="NOTE" onClick="x()">b</Callout>',
      file,
    ).problems;
    expect(found).toHaveLength(1);
  });

  it("ignores forbidden spellings inside a code fence", () => {
    // An AST gate sees a code block; a line scanner saw `onclick=` and refused
    // a document that was merely documenting one.
    const body = [
      "```html",
      '<div onclick="steal()" STYLE="color:red">example</div>',
      "```",
      "",
    ].join("\n");
    expect(problems(body, file)).toBe("");
  });

  it("applies the MDX gate only to .mdx files", () => {
    expect(problems('<Callout type="NOTE" onClick="x()">b</Callout>')).toBe("");
  });

  it("reports the component names a body uses", () => {
    const document = extract(
      '<Callout type="NOTE">b</Callout>\n\n<Gallery caption="c" />\n',
      file,
    );
    expect(document.components).toContain("Callout");
    expect(document.components).toContain("Gallery");
  });

  it("keeps the documented component list in one place", () => {
    expect(ALLOWED_MDX_COMPONENTS).toContain("Figure");
    expect(ALLOWED_MDX_COMPONENTS).toContain("VideoEmbed");
  });
});
