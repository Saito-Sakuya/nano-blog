import { describe, expect, it } from "vitest";

import {
  archivePageUrl,
  directoryPageUrl,
  directoryUrl,
  homePageUrl,
  pageNumbers,
  pageSlice,
  paginate,
  postUrl,
  seriesPageUrl,
  seriesUrl,
  tagUrl,
} from "../../src/lib/routing/urls";

describe("URL shapes", () => {
  it("always uses a trailing slash for HTML routes", () => {
    for (const url of [
      postUrl("dev/web/a"),
      directoryUrl(["dev"]),
      directoryPageUrl(["dev"], 2),
      homePageUrl(2),
      archivePageUrl(3),
      tagUrl("web-dev"),
      seriesUrl("astro-notes"),
    ]) {
      expect(url.endsWith("/")).toBe(true);
    }
  });

  it("never emits a /page/1/ alias", () => {
    expect(homePageUrl(1)).toBe("/");
    expect(archivePageUrl(1)).toBe("/archive/");
    expect(directoryPageUrl([], 1)).toBe("/posts/");
    expect(tagUrl("x")).toBe("/tags/x/");
    expect(seriesPageUrl("x", 1)).toBe("/series/x/");
  });

  it("places pagination inside the directory it paginates", () => {
    expect(directoryPageUrl(["dev", "web"], 3)).toBe("/posts/dev/web/page/3/");
    expect(directoryPageUrl([], 2)).toBe("/posts/page/2/");
  });

  it("builds a canonical post URL from the entry id", () => {
    expect(postUrl("dev/web/a")).toBe("/posts/dev/web/a/");
  });
});

describe("paginate", () => {
  it("reports a single page with no controls", () => {
    const result = paginate(5, 1, (page) => homePageUrl(page));
    expect(result.totalPages).toBe(1);
    expect(result.previousUrl).toBeNull();
    expect(result.nextUrl).toBeNull();
  });

  it("omits a previous link on the first page", () => {
    const result = paginate(25, 1, (page) => homePageUrl(page));
    expect(result.previousUrl).toBeNull();
    expect(result.nextUrl).toBe("/page/2/");
  });

  it("omits a next link on the last page", () => {
    const result = paginate(25, 3, (page) => homePageUrl(page));
    expect(result.previousUrl).toBe("/page/2/");
    expect(result.nextUrl).toBeNull();
  });

  it("marks the current page exactly once", () => {
    const result = paginate(25, 2, (page) => homePageUrl(page));
    expect(result.links.filter((link) => link.current)).toHaveLength(1);
    expect(result.links.find((link) => link.current)?.page).toBe(2);
  });

  it("rounds a partial final page up", () => {
    expect(paginate(21, 1, (page) => homePageUrl(page)).totalPages).toBe(3);
    expect(paginate(20, 1, (page) => homePageUrl(page)).totalPages).toBe(2);
  });

  it("treats an empty list as one empty page", () => {
    const result = paginate(0, 1, (page) => homePageUrl(page));
    expect(result.totalPages).toBe(1);
    expect(result.totalItems).toBe(0);
  });
});

describe("pageNumbers", () => {
  it("always offers at least page one", () => {
    expect(pageNumbers(0)).toEqual([1]);
  });

  it("lists every page", () => {
    expect(pageNumbers(25)).toEqual([1, 2, 3]);
  });
});

describe("pageSlice", () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);

  it("returns the first ten", () => {
    expect(pageSlice(items, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns a short final page", () => {
    expect(pageSlice(items, 3)).toEqual([21, 22, 23, 24, 25]);
  });

  it("returns nothing past the end", () => {
    expect(pageSlice(items, 9)).toEqual([]);
  });
});
