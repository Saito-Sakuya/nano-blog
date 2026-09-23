import { describe, expect, it } from "vitest";

import { validateMdx } from "../../src/lib/markdown/mdx-validate";

/** True when the validator reported at least one problem. */
function rejected(source: string): boolean {
  return validateMdx(source, "test.mdx").length > 0;
}

function messages(source: string): string {
  return validateMdx(source, "test.mdx")
    .map((issue) => issue.message)
    .join(" | ");
}

describe("validateMdx — accepted content", () => {
  it("accepts plain Markdown", () => {
    expect(rejected("# Title\n\nSome *text*.")).toBe(false);
  });

  it("accepts a whitelisted component with static props", () => {
    expect(
      rejected('<Callout type="NOTE" title="A title">\nBody\n</Callout>'),
    ).toBe(false);
  });

  it("accepts a boolean attribute written as an expression literal", () => {
    expect(
      rejected('<Figure src="/media/a/1600.webp" alt="x" decorative={true} />'),
    ).toBe(false);
  });

  it("accepts a number attribute written as an expression literal", () => {
    expect(
      rejected('<Figure src="/media/a/1600.webp" alt="x" width={800} />'),
    ).toBe(false);
  });

  it("accepts an https URL prop", () => {
    expect(
      rejected(
        '<VideoEmbed provider="youtube" id="dQw4w9WgXcQ" title="t" poster="/media/a/1600.webp" />',
      ),
    ).toBe(false);
  });

  it("accepts allowed inline raw HTML", () => {
    expect(rejected("Some <kbd>Ctrl</kbd> and <mark>marked</mark> text.")).toBe(
      false,
    );
  });
});

describe("validateMdx — module syntax", () => {
  it("rejects an import", () => {
    expect(rejected("import x from 'y'\n\nText")).toBe(true);
    expect(messages("import x from 'y'\n\nText")).toMatch(/import and export/u);
  });

  it("rejects an export", () => {
    expect(rejected("export const a = 1\n\nText")).toBe(true);
  });
});

describe("validateMdx — expressions", () => {
  it("rejects a flow expression", () => {
    expect(rejected("{process.env.SECRET}")).toBe(true);
  });

  it("rejects an expression inside text", () => {
    expect(rejected("Text {1 + 1} more")).toBe(true);
  });
});

describe("validateMdx — components", () => {
  it("rejects an unknown component", () => {
    expect(rejected('<Script src="x" />')).toBe(true);
    expect(messages('<Script src="x" />')).toMatch(
      /not a whitelisted component/u,
    );
  });

  it("rejects a component with an unknown prop", () => {
    expect(rejected('<Callout type="NOTE" nonsense="x">b</Callout>')).toBe(
      true,
    );
  });

  it("rejects an invalid enum value", () => {
    expect(rejected('<Callout type="DANGER">b</Callout>')).toBe(true);
  });

  it("rejects a missing required prop", () => {
    expect(rejected("<Tab>body</Tab>")).toBe(true);
  });

  it("rejects spread props", () => {
    expect(rejected("<Callout {...props}>b</Callout>")).toBe(true);
    expect(messages("<Callout {...props}>b</Callout>")).toMatch(
      /Spread props/u,
    );
  });

  it("rejects a JSX fragment", () => {
    expect(rejected('<>\n  <Callout type="NOTE">b</Callout>\n</>')).toBe(true);
  });
});

describe("validateMdx — attribute values", () => {
  it("rejects a non-literal expression prop", () => {
    expect(rejected('<Figure src={someVar} alt="x" />')).toBe(true);
  });
  it("rejects a member expression prop", () => {
    expect(rejected('<Figure src={a.b} alt="x" />')).toBe(true);
  });

  it("rejects a call expression prop", () => {
    expect(rejected('<Figure src={f()} alt="x" />')).toBe(true);
  });

  it("rejects a template literal prop", () => {
    expect(rejected('<Figure src={`a${b}`} alt="x" />')).toBe(true);
  });

  it("rejects an operator expression prop", () => {
    expect(rejected('<Callout type={"NO" + "TE"}>b</Callout>')).toBe(true);
  });
});

describe("validateMdx — forbidden attributes", () => {
  it("rejects an event handler", () => {
    expect(rejected('<Callout type="NOTE" onClick="x()">b</Callout>')).toBe(
      true,
    );
  });

  it("rejects an inline style", () => {
    expect(rejected('<Callout type="NOTE" style="color:red">b</Callout>')).toBe(
      true,
    );
  });

  it("rejects an Astro client directive", () => {
    expect(rejected('<Callout type="NOTE" client:load>b</Callout>')).toBe(true);
  });

  it("rejects set:html", () => {
    expect(
      rejected('<Callout type="NOTE" set:html="<b>x</b>">b</Callout>'),
    ).toBe(true);
  });
});

describe("validateMdx — raw HTML", () => {
  for (const tag of [
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "svg",
    "style",
  ]) {
    it(`rejects raw <${tag}>`, () => {
      expect(rejected(`<${tag}></${tag}>`)).toBe(true);
    });
  }
});

describe("validateMdx — URLs", () => {
  it("rejects a javascript: URL", () => {
    expect(rejected('<Figure src="javascript:alert(1)" alt="x" />')).toBe(true);
  });

  it("rejects a data: URL", () => {
    expect(
      rejected('<Figure src="data:text/html;base64,PHNjcmlwdD4=" alt="x" />'),
    ).toBe(true);
  });

  it("rejects a protocol-relative URL", () => {
    expect(rejected('<Figure src="//evil.example/x.png" alt="x" />')).toBe(
      true,
    );
  });

  it("rejects a plain http URL", () => {
    expect(rejected('<Figure src="http://evil.example/x.png" alt="x" />')).toBe(
      true,
    );
  });
});

describe("validateMdx — reporting", () => {
  it("reports every problem rather than stopping at the first", () => {
    const issues = validateMdx(
      "import a from 'b'\n\n<Script />\n\n<Nope />",
      "test.mdx",
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it("reports line numbers so an author can find the problem", () => {
    const issues = validateMdx("Line one\n\n<Script />", "test.mdx");
    expect(issues[0]?.line).toBe(3);
  });

  it("reports a parse failure rather than throwing", () => {
    const issues = validateMdx('<Callout type="NOTE"', "test.mdx");
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("validateMdx — child counts", () => {
  const figure = '<Figure src="/media/a/1600.webp" alt="x" />';

  it("accepts a gallery of two to six figures", () => {
    expect(rejected(`<Gallery>${figure}${figure}</Gallery>`)).toBe(false);
    expect(rejected(`<Gallery>${figure.repeat(6)}</Gallery>`)).toBe(false);
  });

  it("rejects a gallery of fewer than two figures", () => {
    expect(rejected(`<Gallery>${figure}</Gallery>`)).toBe(true);
    expect(messages(`<Gallery>${figure}</Gallery>`)).toMatch(
      /between 2 and 6/u,
    );
  });

  it("rejects a gallery of more than six figures", () => {
    expect(rejected(`<Gallery>${figure.repeat(7)}</Gallery>`)).toBe(true);
  });

  it("accepts a tab group of two to six tabs", () => {
    expect(
      rejected('<Tabs><Tab label="a">x</Tab><Tab label="b">y</Tab></Tabs>'),
    ).toBe(false);
  });

  it("rejects a single-tab group", () => {
    expect(rejected('<Tabs><Tab label="a">x</Tab></Tabs>')).toBe(true);
  });

  it("ignores non-matching children when counting", () => {
    expect(
      rejected(
        `<Gallery>${figure}<Callout type="NOTE">x</Callout>${figure}</Gallery>`,
      ),
    ).toBe(false);
  });

  it("counts a group written across several lines", () => {
    /*
     * The shape the fixtures use, and the one that exposed the counting bug:
     * `remark-mdx` parses `<Tab label="第一页">` followed by indented body text
     * as a flow element, but a `<Tab …>text</Tab>` on a single line as a text
     * element wrapped in a paragraph. Counting direct children only reported a
     * two-tab group as containing one tab, so a valid document was refused.
     */
    const tabs = [
      '<Tabs label="t">',
      '  <Tab label="a">',
      "    first body",
      "  </Tab>",
      '  <Tab label="b">second body</Tab>',
      "</Tabs>",
    ].join("\n");

    expect(rejected(tabs), messages(tabs)).toBe(false);
  });

  it("counts a gallery whose figures are written one per line", () => {
    const gallery = [
      "<Gallery>",
      '  <Figure src="/media/a/1600.webp" alt="one" />',
      '  <Figure src="/media/b/1600.webp" alt="two" />',
      "</Gallery>",
    ].join("\n");

    expect(rejected(gallery), messages(gallery)).toBe(false);
  });

  it("does not count a nested group's children twice", () => {
    // A `Tab` inside a `Tab` is still one tab in the outer group.
    const tabs = [
      '<Tabs label="t">',
      '  <Tab label="a">',
      '    <Tab label="inner">x</Tab>',
      "  </Tab>",
      '  <Tab label="b">y</Tab>',
      "</Tabs>",
    ].join("\n");

    expect(rejected(tabs), messages(tabs)).toBe(false);
  });
});

describe("validateMdx — attribute names are case-insensitive", () => {
  /*
   * JSX preserves the spelling, and a browser matching attribute names
   * case-insensitively treats `onclick`, `onClick` and `ONCLICK` as the same
   * handler. A case-sensitive `/^on[A-Z]/` accepted the lowercase spelling —
   * the one that actually ships — and published it into static HTML.
   */

  it("rejects an event handler in any spelling", () => {
    for (const attribute of [
      'onclick="steal()"',
      'onClick="steal()"',
      'ONCLICK="steal()"',
      'onMouseOver="steal()"',
    ]) {
      const source = `<Callout type="NOTE" ${attribute}>b</Callout>`;
      expect(rejected(source), attribute).toBe(true);
      expect(messages(source), attribute).toMatch(/not allowed/u);
    }
  });

  it("rejects an inline style in any spelling", () => {
    for (const attribute of ['style="color:red"', 'STYLE="color:red"']) {
      const source = `<Callout type="NOTE" ${attribute}>b</Callout>`;
      expect(rejected(source), attribute).toBe(true);
    }
  });

  it("rejects a forbidden attribute on raw HTML too", () => {
    expect(rejected('<span ONCLICK="x()">t</span>')).toBe(true);
    expect(rejected('<span STYLE="color:red">t</span>')).toBe(true);
  });

  it("treats every `on…` attribute as a handler", () => {
    // Deliberately over-broad: HTML defines no attribute that begins with `on`
    // and is not an event handler, so refusing the whole family is the safe
    // direction, and it cannot be defeated by a spelling nobody has seen yet.
    for (const source of [
      '<div once="yes">t</div>',
      '<div oncustomthing="x()">t</div>',
    ]) {
      expect(rejected(source), source).toBe(true);
    }
  });
});

describe("validateMdx — URL attributes", () => {
  it("accepts an https URL and a site-absolute path", () => {
    expect(
      rejected('<Figure src="https://example.invalid/x.png" alt="x" />'),
    ).toBe(false);
    expect(rejected('<Figure src="/media/a/1600.webp" alt="x" />')).toBe(false);
  });

  it("rejects the spellings a browser reads as another origin", () => {
    /*
     * `\` is `/` to the WHATWG parser for special schemes, and tab is removed
     * before parsing. `/\evil.example/x` and `/<tab>/evil.example` are the same
     * URL as `//evil.example/x`, which is why the check parses the value instead
     * of looking at its first characters.
     */
    for (const src of [
      "//evil.example/x.png",
      "/\\evil.example/x.png",
      "/\t/evil.example",
      "/\\/evil.example/x",
    ]) {
      const source = `<Figure src="${src}" alt="x" />`;
      expect(rejected(source), JSON.stringify(src)).toBe(true);
      expect(messages(source), JSON.stringify(src)).toMatch(
        /https URL or a site-absolute path/u,
      );
    }
  });

  it("rejects a relative path, which may point outside the site", () => {
    expect(rejected('<Figure src="../../secret.png" alt="x" />')).toBe(true);
  });
});

describe("validateMdx — the Figure contract", () => {
  it("accepts the props Figure.astro declares", () => {
    // `Figure.astro` takes `sizes` for a figure that does not render at the
    // article column's width — a figure inside a `Gallery`. The schema is
    // strict, so a prop the component accepts but the schema did not know about
    // refused valid content.
    const source = [
      "<Figure",
      '  src="/media/a/1200.webp"',
      '  alt="x"',
      '  caption="c"',
      '  credit="cr"',
      "  width={832}",
      '  sizes="(min-width: 48rem) 21rem, 50vw"',
      "/>",
    ].join("\n");

    expect(rejected(source), messages(source)).toBe(false);
  });

  it("still rejects a prop the component does not declare", () => {
    expect(
      rejected('<Figure src="/media/a/1600.webp" alt="x" loading="lazy" />'),
    ).toBe(true);
  });
});
