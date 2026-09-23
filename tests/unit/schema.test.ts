import { describe, expect, it } from "vitest";

import {
  coverSchema,
  indexSchema,
  pageSchema,
  postSchema,
  seriesSchema,
  tagSchema,
} from "../../src/lib/content/schema";

/** A minimal valid post, which individual tests then mutate. */
function validPost(): Record<string, unknown> {
  return {
    title: "一篇合格的文章标题",
    description:
      "这是一段长度确实落在四十到一百六十个字符之间的合格摘要文字，用来验证 frontmatter 字段校验。",
    publishedAt: "2026-09-15T09:00:00+08:00",
    cover: {
      src: `/media/${"a".repeat(64)}/1600.webp`,
      alt: "一张描述具体画面内容的封面图",
      width: 1600,
      height: 900,
    },
  };
}

function firstIssue(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string {
  return result.error?.issues.map((issue) => issue.message).join(" | ") ?? "";
}

describe("postSchema — accepted input", () => {
  it("accepts a minimal post and applies defaults", () => {
    const result = postSchema.safeParse(validPost());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.draft).toBe(false);
    expect(result.data.tags).toEqual([]);
    expect(result.data.toc).toBe("auto");
    expect(result.data.lang).toBe("zh-CN");
    expect(result.data.license).toBe("CC-BY-4.0");
  });

  it("accepts an explicit UTC offset", () => {
    const input = validPost();
    input["publishedAt"] = "2026-09-15T09:00:00Z";
    expect(postSchema.safeParse(input).success).toBe(true);
  });

  it("keeps the datetime string exactly as written", () => {
    // The author-tools path: `js-yaml@5` has no timestamp type, so the value
    // arrives as text and passes through with the offset the author chose.
    const input = validPost();
    input["publishedAt"] = "2026-09-15T09:00:00+08:00";
    const result = postSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.publishedAt).toBe("2026-09-15T09:00:00+08:00");
  });

  it("accepts a Date, which Astro’s frontmatter parser produces", () => {
    /*
     * The build path. Astro's content loader parses frontmatter through
     * `@astrojs/internal-helpers`, which depends on `js-yaml@4` — a second copy
     * installed beside the project's `js-yaml@5`, still implementing the YAML
     * 1.1 timestamp type. So the same `publishedAt:` line reaches this schema
     * as a `Date` during a build, and rejecting it fails the build with
     * `Expected type "string", received "object"`.
     */
    const input = validPost();
    input["publishedAt"] = new Date("2026-09-15T01:00:00.000Z");
    const result = postSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.publishedAt).toBe("2026-09-15T01:00:00.000Z");
  });

  it("normalises both spellings of one instant to the same string", () => {
    // The contract the two branches exist to uphold: whichever parser read the
    // file, the rest of the build sees one type and one value.
    const fromString = postSchema.safeParse({
      ...validPost(),
      publishedAt: "2026-09-15T01:00:00.000Z",
    });
    const fromDate = postSchema.safeParse({
      ...validPost(),
      publishedAt: new Date("2026-09-15T01:00:00.000Z"),
    });

    expect(fromString.success && fromDate.success).toBe(true);
    if (!fromString.success || !fromDate.success) return;
    expect(fromString.data.publishedAt).toBe(fromDate.data.publishedAt);
    expect(Date.parse(fromString.data.publishedAt)).toBe(
      Date.parse("2026-09-15T01:00:00.000Z"),
    );
  });

  it("accepts up to five tags", () => {
    const input = validPost();
    input["tags"] = Array.from({ length: 5 }, (_, index) => ({
      id: `tag-${index}`,
      label: `标签 ${index}`,
    }));
    expect(postSchema.safeParse(input).success).toBe(true);
  });
});

describe("postSchema — rejected input", () => {
  it("rejects an unknown key rather than ignoring it", () => {
    const input = { ...validPost(), featured: true };
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const input = validPost();
    delete input["title"];
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a description that is too short", () => {
    const input = { ...validPost(), description: "太短了" };
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a description that is too long", () => {
    const input = { ...validPost(), description: "字".repeat(161) };
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("counts a Chinese title in code points, not UTF-16 units", () => {
    // 80 code points would be 240 UTF-16 units if astral characters were used;
    // plain Han characters are one unit each, so this is exactly at the limit.
    const input = { ...validPost(), title: "字".repeat(80) };
    expect(postSchema.safeParse(input).success).toBe(true);
    expect(
      postSchema.safeParse({ ...validPost(), title: "字".repeat(81) }).success,
    ).toBe(false);
  });

  it("rejects leading and trailing whitespace instead of trimming it", () => {
    const result = postSchema.safeParse({ ...validPost(), title: " 标题 " });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toMatch(/whitespace/u);
  });

  it("rejects control characters", () => {
    expect(
      postSchema.safeParse({ ...validPost(), title: "a\u0007b" }).success,
    ).toBe(false);
  });

  it("rejects NUL, escape and DEL inside otherwise valid text", () => {
    for (const bad of ["\u0000", "\u001b", "\u007f"]) {
      expect(
        postSchema.safeParse({ ...validPost(), title: `标题${bad}标题` })
          .success,
      ).toBe(false);
    }
  });

  it("keeps tab and newline out of the rejected set, which the schema does not police", () => {
    // The rule is "binary control characters". Tab, LF, VT, FF and CR are not
    // in it: the whitespace rule rejects them at the edges, and a body of text
    // is free to contain them.
    const result = postSchema.safeParse({
      ...validPost(),
      description: `第一段\n第二段，这一段含有制表符\t与换行符，长度仍然在四十到一百六十个字符之间。`,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a naive datetime with no offset", () => {
    const input = { ...validPost(), publishedAt: "2026-09-15T09:00:00" };
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a date-only value", () => {
    const input = { ...validPost(), publishedAt: "2026-09-15" };
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects updatedAt earlier than publishedAt", () => {
    const input = { ...validPost(), updatedAt: "2026-01-01T00:00:00+08:00" };
    const result = postSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toMatch(/earlier/u);
  });

  it("accepts updatedAt equal to publishedAt", () => {
    const input = { ...validPost(), updatedAt: "2026-09-15T09:00:00+08:00" };
    expect(postSchema.safeParse(input).success).toBe(true);
  });

  it("rejects more than five tags", () => {
    const input = validPost();
    input["tags"] = Array.from({ length: 6 }, (_, index) => ({
      id: `tag-${index}`,
      label: `标签 ${index}`,
    }));
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate tag ids", () => {
    const input = validPost();
    input["tags"] = [
      { id: "same", label: "甲" },
      { id: "same", label: "乙" },
    ];
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a missing cover, which is required", () => {
    const input = validPost();
    delete input["cover"];
    expect(postSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a non-https canonical URL", () => {
    expect(
      postSchema.safeParse({
        ...validPost(),
        canonicalUrl: "http://example.invalid/x",
      }).success,
    ).toBe(false);
  });

  it("rejects a toc value outside the enum", () => {
    expect(
      postSchema.safeParse({ ...validPost(), toc: "sometimes" }).success,
    ).toBe(false);
  });
});

describe("coverSchema", () => {
  it("requires the content-addressed 1600.webp path", () => {
    const base = {
      src: `/media/${"a".repeat(64)}/1600.webp`,
      alt: "描述文字够长",
      width: 1600,
      height: 900,
    };
    expect(coverSchema.safeParse(base).success).toBe(true);

    for (const src of [
      `/media/${"a".repeat(64)}/800.webp`,
      `/media/${"a".repeat(63)}/1600.webp`,
      `/media/${"A".repeat(64)}/1600.webp`,
      `https://media.example.invalid/media/${"a".repeat(64)}/1600.webp`,
      "media/a/1600.webp",
    ]) {
      expect(coverSchema.safeParse({ ...base, src }).success).toBe(false);
    }
  });

  it("rejects the wrong dimensions", () => {
    const base = {
      src: `/media/${"a".repeat(64)}/1600.webp`,
      alt: "描述文字够长",
      width: 1600,
      height: 900,
    };
    expect(coverSchema.safeParse({ ...base, width: 1200 }).success).toBe(false);
    expect(coverSchema.safeParse({ ...base, height: 600 }).success).toBe(false);
  });

  it("rejects alt text that is too short to describe anything", () => {
    const base = {
      src: `/media/${"a".repeat(64)}/1600.webp`,
      width: 1600,
      height: 900,
    };
    expect(coverSchema.safeParse({ ...base, alt: "图" }).success).toBe(false);
  });
});

describe("tagSchema and seriesSchema", () => {
  it("requires a kebab-case tag id", () => {
    expect(tagSchema.safeParse({ id: "web-dev", label: "开发" }).success).toBe(
      true,
    );
    for (const id of ["Web-Dev", "web_dev", "web dev", "-web", "web-"]) {
      expect(tagSchema.safeParse({ id, label: "开发" }).success).toBe(false);
    }
  });

  it("requires a positive integer series order", () => {
    const base = { id: "astro-notes", title: "Astro 笔记" };
    expect(seriesSchema.safeParse({ ...base, order: 1 }).success).toBe(true);
    expect(seriesSchema.safeParse({ ...base, order: 0 }).success).toBe(false);
    expect(seriesSchema.safeParse({ ...base, order: -1 }).success).toBe(false);
    expect(seriesSchema.safeParse({ ...base, order: 1.5 }).success).toBe(false);
  });
});

describe("pageSchema", () => {
  const base = {
    title: "关于本站",
    description:
      "这一页说明本站的身份、写作范围与内容许可，并且完全不包含任何虚构的个人信息或联系方式。",
  };

  it("accepts a minimal page", () => {
    const result = pageSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.noindex).toBe(false);
  });

  it("allows an explicit noindex", () => {
    const result = pageSchema.safeParse({ ...base, noindex: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.noindex).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(pageSchema.safeParse({ ...base, template: "wide" }).success).toBe(
      false,
    );
  });
});

describe("indexSchema", () => {
  const base = {
    title: "笔记",
    description: "浏览此目录下的公开文章与子目录，以及更下层的目录。",
  };

  it("accepts a minimal index and defaults its order to zero", () => {
    const result = indexSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.order).toBe(0);
  });

  it("allows a negative order, which sorts a directory first", () => {
    expect(indexSchema.safeParse({ ...base, order: -1 }).success).toBe(true);
  });

  it("uses a shorter description budget than a post", () => {
    expect(
      indexSchema.safeParse({ ...base, description: "字".repeat(20) }).success,
    ).toBe(true);
    expect(
      indexSchema.safeParse({ ...base, description: "字".repeat(19) }).success,
    ).toBe(false);
    expect(
      indexSchema.safeParse({ ...base, description: "字".repeat(161) }).success,
    ).toBe(false);
  });
});
