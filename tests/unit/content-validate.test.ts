import { describe, expect, it } from "vitest";

import type {
  ContentCollection,
  ContentEntry,
  ContentIssue,
  ContentSource,
} from "../../scripts/content/load";
import { validateSource } from "../../scripts/content/validate";

/**
 * The release gate.
 *
 * Two properties are pinned here, both of them things a passing build does not
 * prove on its own:
 *
 * - **Strictness follows `draft`, not the clock.** A `draft: false` article
 *   with a future `publishedAt` is an article the next build publishes; it must
 *   satisfy every body and media rule today. Deciding strictness by visibility
 *   let an empty body and a missing cover pass with zero errors.
 * - **Anchors are the ids the renderer emits.** A file with `## A`, `## A` and
 *   `## A-2` publishes `a`, `a-2` and `a-2-2`, and a link to `#a-2` must
 *   resolve while a link to a heading that does not exist must not.
 */

const NOW = new Date("2026-09-15T00:00:00.000Z");
const FUTURE = "2099-12-31T23:59:00+08:00";
const DIGEST = "a".repeat(64);
const COVER_SRC = `/media/${DIGEST}/1600.webp`;

interface EntrySpec {
  readonly relativePath: string;
  readonly collection?: ContentCollection;
  readonly url?: string;
  readonly data?: Record<string, unknown>;
  readonly body?: string;
}

function entryOf(spec: EntrySpec): ContentEntry {
  const collection = spec.collection ?? "posts";
  return {
    collection,
    relativePath: spec.relativePath,
    absolutePath: `/content/${spec.relativePath}`,
    collectionPath: spec.relativePath.replace(/^(?:posts|pages)\//u, ""),
    url: spec.url ?? `/${spec.relativePath.replace(/\.mdx?$/u, "")}/`,
    source: "",
    data: spec.data ?? {},
    parsed: null,
    body: spec.body ?? "",
    bodyStartLine: 1,
    bytes: 0,
    issues: [],
  };
}

function sourceOf(
  entries: readonly ContentEntry[],
  issues: readonly ContentIssue[] = [],
): ContentSource {
  return {
    kind: "directory",
    root: "/content",
    label: "test",
    entries,
    issues,
    mediaRecords: new Map(),
  };
}

function report(
  entries: readonly ContentEntry[],
  issues: readonly ContentIssue[] = [],
) {
  return validateSource({
    source: sourceOf(entries, issues),
    now: NOW,
    publication: true,
    strictMedia: true,
  });
}

function errorsOf(
  result: ReturnType<typeof validateSource>,
  code: string,
): ContentIssue[] {
  return result.issues.filter(
    (issue) => issue.severity === "error" && issue.code === code,
  );
}

function warningsOf(
  result: ReturnType<typeof validateSource>,
  code: string,
): ContentIssue[] {
  return result.issues.filter(
    (issue) => issue.severity === "warning" && issue.code === code,
  );
}

/** A post that is complete in every way except the body under test. */
function postData(overrides: Record<string, unknown> = {}) {
  return {
    title: "一篇合格的文章标题",
    description: "一段长度足够的描述文字，用来占位以便通过 schema 校验。",
    publishedAt: FUTURE,
    draft: false,
    ...overrides,
  };
}

describe("validateSource — strictness follows draft, not visibility", () => {
  it("rejects an empty body on a future-dated article", () => {
    // The headline defect: `draft: false` plus a future `publishedAt` was read
    // as "not public", so `content:publish` accepted an empty article.
    const result = report([
      entryOf({ relativePath: "posts/future.md", data: postData(), body: "" }),
    ]);

    expect(errorsOf(result, "body-empty")).toHaveLength(1);
  });

  it("rejects a body H1 on a future-dated article", () => {
    const result = report([
      entryOf({
        relativePath: "posts/future.md",
        data: postData(),
        body: "# 正文一级标题\n\n正文。\n",
      }),
    ]);

    expect(errorsOf(result, "body-h1")).toHaveLength(1);
  });

  it("rejects a missing cover record on a future-dated article", () => {
    const result = report([
      entryOf({
        relativePath: "posts/future.md",
        data: postData({
          cover: {
            src: COVER_SRC,
            alt: "一张描述具体画面内容的封面图",
            width: 1600,
            height: 900,
          },
        }),
        body: "正文。\n",
      }),
    ]);

    expect(errorsOf(result, "media-missing").length).toBeGreaterThan(0);
    expect(
      result.issues.some(
        (issue) => issue.severity === "error" && issue.field === "cover",
      ),
    ).toBe(true);
  });

  it("treats an unparsable date as strict, because it cannot be called public", () => {
    const result = report([
      entryOf({
        relativePath: "posts/broken-date.md",
        data: postData({ publishedAt: "not-a-date" }),
        body: "",
      }),
    ]);

    // The date error is reported, and the missing body is an error rather than
    // being excused by a visibility answer nobody could compute.
    expect(errorsOf(result, "date")).toHaveLength(1);
    expect(errorsOf(result, "body-empty")).toHaveLength(1);
  });

  it("still checks a draft's body only as a warning", () => {
    const result = report([
      entryOf({
        relativePath: "posts/draft.md",
        data: postData({ draft: true }),
        body: "# 草稿一级标题\n",
      }),
    ]);

    expect(errorsOf(result, "body-empty")).toHaveLength(0);
    expect(errorsOf(result, "body-h1")).toHaveLength(0);
  });

  it("keeps a missing cover a warning when media is not being verified", () => {
    const result = validateSource({
      source: sourceOf([
        entryOf({
          relativePath: "posts/future.md",
          data: postData({
            cover: {
              src: COVER_SRC,
              alt: "一张描述具体画面内容的封面图",
              width: 1600,
              height: 900,
            },
          }),
          body: "正文。\n",
        }),
      ]),
      now: NOW,
      publication: false,
      strictMedia: false,
    });

    expect(errorsOf(result, "media-missing")).toHaveLength(0);
    expect(warningsOf(result, "media-missing").length).toBeGreaterThan(0);
  });

  it("counts a future-dated article as unpublished, which is a different question", () => {
    // Strictness changed; visibility did not. The report still says this build
    // publishes nothing.
    const result = report([
      entryOf({
        relativePath: "posts/future.md",
        data: postData(),
        body: "正文。\n",
      }),
    ]);

    expect(result.publicPosts).toBe(0);
    expect(result.entryCount).toBe(1);
  });

  it("counts a past-dated article as published", () => {
    const result = report([
      entryOf({
        relativePath: "posts/past.md",
        data: postData({ publishedAt: "2026-01-01T00:00:00+08:00" }),
        body: "正文。\n",
      }),
    ]);

    expect(result.publicPosts).toBe(1);
  });
});

describe("validateSource — anchors are the rendered ids", () => {
  const duplicated = "## A\n\n## A\n\n## A-2\n\n";

  it("accepts a link to the id a repeated heading actually took", () => {
    const result = report([
      entryOf({
        relativePath: "posts/notes/a.md",
        data: postData(),
        body: `${duplicated}[see](#a-2)\n\n[again](#a-2-2)\n`,
      }),
    ]);

    expect(errorsOf(result, "link")).toHaveLength(0);
  });

  it("rejects a link to an id no heading has", () => {
    const result = report([
      entryOf({
        relativePath: "posts/notes/a.md",
        data: postData(),
        body: `${duplicated}[nowhere](#a-3)\n`,
      }),
    ]);

    const links = errorsOf(result, "link");
    expect(links).toHaveLength(1);
    expect(links[0]?.message).toMatch(/#a-3/u);
  });

  it("resolves a cross-file anchor against the target's real ids", () => {
    const result = report([
      entryOf({
        relativePath: "posts/notes/a.md",
        data: postData({ draft: true }),
        body: duplicated,
      }),
      entryOf({
        relativePath: "posts/notes/b.md",
        data: postData(),
        body: "[see](a.md#a-2)\n\n[again](a.md#a-2-2)\n",
      }),
    ]);

    expect(errorsOf(result, "link")).toHaveLength(0);
  });
});

describe("validateSource — paths", () => {
  it("reports a path the loader did not catch", () => {
    // The loop that used to call `parseContentPath` inside a `catch` that
    // discarded the error looked like a check and was not one.
    const result = report([
      entryOf({
        relativePath: "pages/About.md",
        collection: "pages",
        url: "/About/",
        data: { title: "关于", description: "一段足够长的描述文字用于占位。" },
        body: "正文。\n",
      }),
    ]);

    const paths = errorsOf(result, "path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.message).toMatch(/kebab-case/u);
  });

  it("does not repeat a path error the loader already reported", () => {
    const loaderIssue: ContentIssue = {
      severity: "error",
      code: "path",
      message: "pages/About.md must be lower-case kebab-case.",
      file: "pages/About.md",
    };

    const result = report(
      [
        entryOf({
          relativePath: "pages/About.md",
          collection: "pages",
          url: "/About/",
          data: {},
          body: "正文。\n",
        }),
      ],
      [loaderIssue],
    );

    // The loader's own issue is carried into the report; what must not happen
    // is a second copy of the same complaint from this module.
    const paths = errorsOf(result, "path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.message).toBe(loaderIssue.message);
  });

  it("accepts a page path that follows the rules", () => {
    const result = report([
      entryOf({
        relativePath: "pages/lab/notes.md",
        collection: "pages",
        data: { title: "关于", description: "一段足够长的描述文字用于占位。" },
        body: "正文。\n",
      }),
    ]);

    expect(errorsOf(result, "path")).toHaveLength(0);
  });
});
