import { describe, expect, it } from "vitest";

import {
  ContentPathError,
  ancestorDirectories,
  contentUrl,
  parseContentPath,
} from "../../src/lib/content/paths";

describe("parseContentPath", () => {
  it("decomposes a post path", () => {
    const parsed = parseContentPath("posts/dev/web/a.md");
    expect(parsed).toMatchObject({
      directories: ["posts", "dev", "web"],
      stem: "a",
      extension: ".md",
      isIndex: false,
    });
  });

  it("accepts .mdx", () => {
    expect(parseContentPath("posts/a.mdx").extension).toBe(".mdx");
  });

  it("recognises a directory index", () => {
    expect(parseContentPath("posts/dev/_index.md").isIndex).toBe(true);
  });
});

describe("parseContentPath rejections", () => {
  const rejected: [string, string][] = [
    ["posts/Dev/a.md", "uppercase directory segment"],
    ["posts/dev/MyPost.md", "uppercase file name"],
    ["posts/dev/a_b.md", "underscore in a file name"],
    ["posts/dev/index.md", '"index" instead of "_index"'],
    ["posts/dev/a.txt", "unsupported extension"],
    ["/posts/dev/a.md", "absolute path"],
    ["posts//dev/a.md", "empty segment"],
    ["posts/page/a.md", "reserved pagination segment"],
    ["posts/dev/a.md/", "trailing slash"],
    ["", "empty path"],
  ];

  for (const [path, reason] of rejected) {
    it(`rejects ${JSON.stringify(path)} (${reason})`, () => {
      expect(() => parseContentPath(path)).toThrow(ContentPathError);
    });
  }

  it("rejects a NUL byte", () => {
    expect(() => parseContentPath("posts/a\0b.md")).toThrow(ContentPathError);
  });
});

describe("parseContentPath — names a filesystem cannot store", () => {
  const reserved = [
    "posts/nul.md",
    "posts/con.md",
    "posts/prn.md",
    "posts/aux.md",
    "posts/com1.md",
    "posts/com9.md",
    "posts/lpt1.md",
    "posts/lpt9.md",
    "posts/aux/_index.md",
    "posts/dev/nul.mdx",
    // Windows reserves the device name whatever the extension, and whatever
    // the case of the name.
    "posts/NUL.md",
  ];

  for (const path of reserved) {
    it(`rejects the reserved device name in ${JSON.stringify(path)}`, () => {
      expect(() => parseContentPath(path)).toThrow(/reserved Windows device/u);
    });
  }

  it("accepts names that merely start like a device name", () => {
    for (const path of [
      "posts/nullable.md",
      "posts/console.md",
      "posts/auxiliary.md",
      "posts/com10.md",
      "posts/lpt.md",
    ]) {
      expect(() => parseContentPath(path), path).not.toThrow();
    }
  });

  it("rejects a colon, which names an NTFS alternate data stream", () => {
    for (const path of [
      "posts/a:b.md",
      "posts/dev:web/a.md",
      "posts/dev/a.md:stream",
    ]) {
      expect(() => parseContentPath(path), path).toThrow(
        /alternate data stream/u,
      );
    }
  });

  it("rejects a segment of 255 bytes or more", () => {
    // 255 is the limit every common filesystem shares, so a name at the limit
    // is exactly the one that fails on the machine that checks the repository
    // out rather than on the one that wrote it.
    expect(() => parseContentPath(`posts/${"a".repeat(255)}.md`)).toThrow(
      /filesystems allow fewer/u,
    );
    expect(() => parseContentPath(`posts/${"a".repeat(255)}/x.md`)).toThrow(
      /filesystems allow fewer/u,
    );
  });

  it("accepts a segment just below the limit", () => {
    // The extension counts: 251 `a`s plus `.md` is 254 bytes.
    expect(() => parseContentPath(`posts/${"a".repeat(251)}.md`)).not.toThrow();
  });
});

describe("parseContentPath — a pages directory has no index route", () => {
  it("rejects pages/_index.md", () => {
    // It would produce `/`, the home page, which the site owns.
    expect(() => parseContentPath("pages/_index.md")).toThrow(
      /directory index under pages/u,
    );
  });

  it("rejects a nested index under pages/", () => {
    // `contentUrl` gave this `/lab/_index/`: a route nothing links to and
    // nothing serves.
    expect(() => parseContentPath("pages/lab/_index.md")).toThrow(
      /directory index under pages/u,
    );
    expect(() => contentUrl("pages/lab/_index.md")).toThrow(
      /directory index under pages/u,
    );
  });

  it("still accepts a directory index under posts/", () => {
    expect(parseContentPath("posts/lab/_index.md").isIndex).toBe(true);
    expect(contentUrl("posts/lab/_index.md")).toBe("/posts/lab/");
    expect(contentUrl("posts/_index.md")).toBe("/posts/");
  });
});

describe("contentUrl", () => {
  it("maps a post to a trailing-slash URL with no date", () => {
    expect(contentUrl("posts/dev/web/a.md")).toBe("/posts/dev/web/a/");
  });

  it("maps a directory index to its directory", () => {
    expect(contentUrl("posts/dev/web/_index.md")).toBe("/posts/dev/web/");
  });

  it("maps the posts root index to /posts/", () => {
    expect(contentUrl("posts/_index.md")).toBe("/posts/");
  });

  it("maps a page to a top-level URL", () => {
    expect(contentUrl("pages/about.md")).toBe("/about/");
    expect(contentUrl("pages/lab/notes.md")).toBe("/lab/notes/");
  });

  it("produces the same URL for .md and .mdx", () => {
    expect(contentUrl("posts/a.md")).toBe(contentUrl("posts/a.mdx"));
  });
});

describe("ancestorDirectories", () => {
  it("returns every level, outermost first", () => {
    expect(ancestorDirectories(["dev", "web", "deep"])).toEqual([
      ["dev"],
      ["dev", "web"],
      ["dev", "web", "deep"],
    ]);
  });

  it("returns nothing for a root-level file", () => {
    expect(ancestorDirectories([])).toEqual([]);
  });
});
