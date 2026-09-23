/*
 * `astro:content` is a virtual module whose declarations live in
 * `.astro/content.d.ts`, and the scripts `tsconfig` compiles this suite without
 * them — Astro's published declarations do not type-check in that program (see
 * the note in `tsconfig.scripts.json`). Importing `collections.ts` by a literal
 * specifier therefore fails the whole type check, so the specifier is built at
 * run time and the shape this test uses is declared here. The module itself is
 * still type-checked, by `astro check` and by the root `tsconfig.json`, where
 * `astro:content` is declared.
 */
function collectionsSpecifier(): string {
  return "../../src/lib/content/collections";
}

interface CollectionsModule {
  readonly loadSite: () => Promise<unknown>;
  readonly resetSiteCache: () => void;
}

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The read model the pages consume.
 *
 * `astro:content` only exists inside an Astro build, so the collections are
 * supplied here. Everything else — the path rules, the visibility rule, the
 * archive's time zone — is the real code.
 *
 * Two things are pinned: a page id goes through the same path rules a post id
 * does (before this, `pages/About.md` produced a `/About/` route that reached
 * the sitemap and the feed), and the archive buckets in the site time zone
 * rather than in a literal that can drift away from `SITE_TIME_ZONE`.
 */

const collections = new Map<string, unknown[]>();

vi.mock("astro:content", () => ({
  getCollection: (name: string) => Promise.resolve(collections.get(name) ?? []),
}));

interface SiteData {
  readonly pages: ReadonlyMap<string, { readonly url: string }>;
  readonly archive: readonly {
    readonly year: string;
    readonly months: readonly { readonly label: string }[];
  }[];
  readonly posts: readonly unknown[];
}

async function loadSiteWith(entries: {
  readonly posts?: readonly unknown[];
  readonly postIndexes?: readonly unknown[];
  readonly pages?: readonly unknown[];
}): Promise<SiteData> {
  collections.clear();
  collections.set("posts", [...(entries.posts ?? [])]);
  collections.set("postIndexes", [...(entries.postIndexes ?? [])]);
  collections.set("pages", [...(entries.pages ?? [])]);

  const collectionsModule = (await import(
    collectionsSpecifier()
  )) as CollectionsModule;
  collectionsModule.resetSiteCache();
  return (await collectionsModule.loadSite()) as SiteData;
}

function pageEntry(id: string) {
  return {
    id,
    filePath: `/content/pages/${id}.md`,
    body: "正文。\n",
    data: {
      lang: "zh-CN",
      license: "CC-BY-4.0",
      draft: false,
      title: "关于本站",
      description: "一段足够长的描述文字，用来占位。",
      noindex: false,
    },
  };
}

function postEntry(id: string, publishedAt: string) {
  return {
    id,
    filePath: `/content/posts/${id}.md`,
    body: "正文。\n",
    data: {
      lang: "zh-CN",
      license: "CC-BY-4.0",
      draft: false,
      title: "一篇合格的文章标题",
      description: "一段长度足够的描述文字，用来占位。",
      publishedAt,
      tags: [],
      toc: "auto",
      comments: true,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("loadSite — page routes", () => {
  it("routes a nested page at the site root", async () => {
    const site = await loadSiteWith({ pages: [pageEntry("lab/notes")] });
    expect(site.pages.get("lab/notes")?.url).toBe("/lab/notes/");
  });

  it("refuses a page id that is not lower-case kebab-case", async () => {
    // Today this reaches the sitemap and RSS as `/About/`, a URL the site does
    // not mean to serve and the route rules refuse everywhere else.
    await expect(loadSiteWith({ pages: [pageEntry("About")] })).rejects.toThrow(
      /kebab-case/u,
    );
  });

  it("refuses a page id that is a directory index", async () => {
    await expect(
      loadSiteWith({ pages: [pageEntry("_index")] }),
    ).rejects.toThrow(/directory index under pages/u);
  });
});

describe("loadSite — archive buckets", () => {
  it("uses SITE_TIME_ZONE, not a literal", async () => {
    /*
     * 2026-08-31T17:00:00Z is 2026-09-01 01:00 in Asia/Taipei and still August
     * in UTC. The archive used to hardcode `Asia/Taipei`, so this assertion
     * fails the moment the site's zone is configured to anything else — which
     * is exactly what makes the two disagreeing.
     */
    vi.stubEnv("SITE_TIME_ZONE", "UTC");
    vi.resetModules();

    const site = await loadSiteWith({
      posts: [postEntry("notes/a", "2026-08-31T17:00:00Z")],
    });

    expect(site.posts).toHaveLength(1);
    expect(site.archive[0]?.year).toBe("2026");
    expect(site.archive[0]?.months[0]?.label).toBe("2026-08");
  });

  it("buckets by the configured zone when that zone is Taipei", async () => {
    vi.stubEnv("SITE_TIME_ZONE", "Asia/Taipei");
    vi.resetModules();

    const site = await loadSiteWith({
      posts: [postEntry("notes/a", "2026-08-31T17:00:00Z")],
    });

    expect(site.archive[0]?.months[0]?.label).toBe("2026-09");
  });
});
