import { describe, expect, it } from "vitest";

import {
  parseDocument,
  parseYamlMapping,
  renderDocument,
  replaceFrontmatter,
} from "../../scripts/content/frontmatter";

const SOURCE = [
  "---",
  "title: 原标题",
  "draft: true",
  "---",
  "",
  "## 第一节",
  "",
  "正文段落，包含 **粗体** 与 `行内代码`。",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
].join("\n");

describe("parseDocument", () => {
  it("splits frontmatter from the body", () => {
    const parsed = parseDocument(SOURCE, "test.md");
    expect(parsed.data["title"]).toBe("原标题");
    expect(parsed.data["draft"]).toBe(true);
    expect(parsed.body).toContain("## 第一节");
    expect(parsed.body).toContain("const x = 1;");
  });

  it("reports a document with no frontmatter block", () => {
    expect(() => parseDocument("## 没有 frontmatter\n", "test.md")).toThrow();
  });
});

describe("parseDocument — the delimiters", () => {
  it("keeps a `---` line that a block scalar contains", () => {
    /*
     * The bug this pins: the closing delimiter was found by comparing *trimmed*
     * lines, so an indented `---` inside a literal block ended the frontmatter
     * in the middle of a string and left the rest of it as body text.
     */
    const source = [
      "---",
      "title: 块标量",
      "description: |",
      "  第一行",
      "  ---",
      "  第三行",
      "---",
      "",
      "正文。",
      "",
    ].join("\n");

    const parsed = parseDocument(source, "test.md");
    expect(parsed.data["description"]).toBe("第一行\n---\n第三行\n");
    expect(parsed.body.trim()).toBe("正文。");
  });

  it("keeps a `---` line inside a folded scalar", () => {
    const source = [
      "---",
      "title: 折叠标量",
      "description: >",
      "  第一行",
      "  ---",
      "  第三行",
      "---",
      "",
      "正文。",
      "",
    ].join("\n");

    expect(parseDocument(source, "test.md").data["description"]).toBe(
      "第一行 --- 第三行\n",
    );
  });

  it("keeps a `---` inside a block scalar in a sequence", () => {
    const source = [
      "---",
      "title: 序列",
      "items:",
      "  - |",
      "    ---",
      "    still the value",
      "---",
      "",
      "正文。",
      "",
    ].join("\n");

    const parsed = parseDocument(source, "test.md");
    expect(parsed.data["items"]).toEqual(["---\nstill the value\n"]);
  });

  it("closes at the first column-0 `---`", () => {
    const source = [
      "---",
      "title: 两个块",
      "description: |",
      "  ---",
      "---",
      "",
      "正文。",
      "",
    ].join("\n");

    const parsed = parseDocument(source, "test.md");
    expect(parsed.data["description"]).toBe("---\n");
    expect(parsed.body.trim()).toBe("正文。");
  });

  it("rejects an indented opening delimiter", () => {
    // `  ---` is a YAML line, not the start of frontmatter: accepting it made a
    // document whose first line is indented look as though it had metadata.
    expect(() =>
      parseDocument("  ---\ntitle: x\n---\n\nbody\n", "test.md"),
    ).toThrow(/---/u);
  });

  it("rejects a document that does not begin with the delimiter", () => {
    expect(() =>
      parseDocument("\n---\ntitle: x\n---\n\nbody\n", "test.md"),
    ).toThrow(/---/u);
  });

  it("rejects an indented closing delimiter", () => {
    expect(() =>
      parseDocument("---\ntitle: x\n  ---\n\nbody\n", "test.md"),
    ).toThrow(/never closed/u);
  });

  it("rejects a delimiter with trailing whitespace", () => {
    expect(() =>
      parseDocument("---\ntitle: x\n--- \n\nbody\n", "test.md"),
    ).toThrow(/never closed/u);
  });

  it("numbers the body from the separator after the delimiter", () => {
    // The blank line that separates frontmatter from prose belongs to the
    // delimiter, and `body` starts after it — so the file line of body line N
    // is `bodyStartLine + N`.
    const parsed = parseDocument(SOURCE, "test.md");
    const fileLines = SOURCE.split("\n");

    expect(fileLines[parsed.bodyStartLine - 1]?.trim()).toBe("");
    expect(fileLines[parsed.bodyStartLine]).toBe(parsed.body.split("\n")[0]);
  });
});

describe("parseDocument — reported line numbers are file lines", () => {
  it("reports an anchor on the line the author can see", () => {
    // `&anchor` sits on file line 3; a number counted from the start of the
    // frontmatter block pointed one line above it.
    const source = [
      "---",
      "title: x",
      "base: &anchor 1",
      "---",
      "",
      "body",
      "",
    ].join("\n");

    expect(() => parseDocument(source, "test.md")).toThrow(/test\.md:3/u);
  });

  it("reports a YAML error on the line the author can see", () => {
    const source = ["---", "title: x", "title: y", "---", "", "body", ""].join(
      "\n",
    );

    expect(() => parseDocument(source, "test.md")).toThrow(/test\.md:3/u);
  });

  it("shifts by the first line a fragment was cut from", () => {
    // A caller holding a fragment rather than a file says where it starts.
    try {
      parseYamlMapping("title: x\nbase: &a 1", "frag.yaml", 10);
      expect.unreachable("the anchor must be rejected");
    } catch (error) {
      expect(String(error)).toMatch(/frag\.yaml:11/u);
    }
  });

  it("counts from line 1 when no offset is given", () => {
    expect(() => parseYamlMapping("base: &a 1", "frag.yaml")).toThrow(
      /frag\.yaml:1/u,
    );
  });
});

describe("renderDocument", () => {
  it("round-trips a parsed document", () => {
    const parsed = parseDocument(SOURCE, "test.md");
    const rendered = renderDocument(parsed.data, parsed.body);
    const reparsed = parseDocument(rendered, "test.md");

    expect(reparsed.data["title"]).toBe("原标题");
    expect(reparsed.data["draft"]).toBe(true);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  it("produces a document parseDocument accepts even with an empty body", () => {
    const rendered = renderDocument({ title: "只有元数据" }, "");
    expect(parseDocument(rendered, "test.md").data["title"]).toBe("只有元数据");
  });
});

describe("replaceFrontmatter", () => {
  it("keeps the body byte-for-byte", () => {
    const before = parseDocument(SOURCE, "test.md").body;
    const after = parseDocument(
      replaceFrontmatter(SOURCE, { title: "新标题", draft: false }, "test.md"),
      "test.md",
    ).body;

    // The guarantee the helper exists for: editing metadata cannot touch prose,
    // code fences or trailing structure.
    expect(after).toBe(before);
  });

  it("applies the new frontmatter", () => {
    const replaced = replaceFrontmatter(
      SOURCE,
      {
        title: "新标题",
        description: "一段足够长的描述文字用于测试替换行为。",
      },
      "test.md",
    );
    const parsed = parseDocument(replaced, "test.md");

    expect(parsed.data["title"]).toBe("新标题");
    expect(parsed.data["description"]).toContain("足够长");
    // Keys absent from the replacement are gone rather than merged.
    expect(parsed.data["draft"]).toBeUndefined();
  });
});
