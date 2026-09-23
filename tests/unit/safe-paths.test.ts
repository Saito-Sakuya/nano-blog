import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, afterAll } from "vitest";

import { ValidationError } from "../../scripts/lib/errors";
import {
  MAX_SEGMENT_LENGTH,
  assertNoCaseCollisions,
  assertSafeRelativePath,
  findCaseInsensitiveCollision,
  isInsideDirectory,
  isMediaObjectPath,
  isSafeRelativePath,
  resolveWithin,
} from "../../scripts/lib/safe-paths";

/**
 * `safe-paths.ts` is the module every untrusted path passes through — manifest
 * paths, workspace files, remote listings — and it had no tests at all. The
 * cases below are the documented rules plus the three Windows shapes that a
 * Linux build accepts and a Windows checkout cannot materialise.
 */

describe("isSafeRelativePath accepts", () => {
  const accepted = [
    "a.md",
    "posts/a.md",
    "posts/dev/web/deep/nested.mdx",
    "posts/_index.md",
    "posts/a b.md",
    "posts/console.md",
    "posts/nully.txt",
    "posts/com10.md",
    "posts/lpt.md",
    "posts/communication.md",
    "a".repeat(MAX_SEGMENT_LENGTH),
  ];

  for (const value of accepted) {
    it(`accepts ${JSON.stringify(value.length > 40 ? `${value.slice(0, 20)}…(${value.length})` : value)}`, () => {
      expect(isSafeRelativePath(value)).toBe(true);
    });
  }
});

describe("isSafeRelativePath rejects", () => {
  const rejected: [string, string][] = [
    ["", "empty value"],
    ["/posts/a.md", "absolute POSIX path"],
    ["posts//a.md", "empty segment"],
    ["posts/a.md/", "trailing slash"],
    ["posts/./a.md", "current-directory segment"],
    ["posts/../a.md", "parent-directory segment"],
    ["..", "a bare parent-directory segment"],
    ["posts/..", "a trailing parent-directory segment"],
    ["posts\\a.md", "backslash separator"],
    ["posts/a\0b.md", "NUL byte"],
    ["posts/a\nb.md", "control character"],
    ["posts/a.md ", "trailing space"],
    ["posts/a.md.", "trailing dot"],
    ["C:/Windows/a.md", "Windows drive letter"],
    ["c:a.md", "drive-relative path"],
    ["posts/a.md:hidden", "NTFS alternate data stream"],
    ["dir/a:b.txt", "alternate data stream on a file"],
    ["posts/con.md", "reserved device name with an extension"],
    ["posts/CON", "reserved device name in upper case"],
    ["posts/Con.md", "reserved device name in mixed case"],
    ["posts/nul.txt", "the null device"],
    ["posts/aux.md", "the auxiliary device"],
    ["posts/prn", "the printer device"],
    ["posts/com1.md", "a serial port"],
    ["posts/lpt9.log", "a parallel port"],
    ["a".repeat(MAX_SEGMENT_LENGTH + 1), "segment above the UTF-16 limit"],
    // 128 × 2 bytes = 256 UTF-8 bytes, over the POSIX component limit, while
    // staying under the UTF-16 one.
    ["é".repeat(128), "segment above the UTF-8 byte limit"],
  ];

  for (const [value, reason] of rejected) {
    it(`rejects ${JSON.stringify(value.length > 40 ? `${value.slice(0, 20)}…(${value.length})` : value)} (${reason})`, () => {
      expect(isSafeRelativePath(value)).toBe(false);
    });
  }

  it("accepts a segment that is inside the byte limit", () => {
    expect(isSafeRelativePath("é".repeat(127))).toBe(true);
  });
});

describe("assertSafeRelativePath", () => {
  it("names the label and the offending value", () => {
    expect(() =>
      assertSafeRelativePath("posts/con.md", "Manifest path"),
    ).toThrowError(ValidationError);
    expect(() =>
      assertSafeRelativePath("posts/con.md", "Manifest path"),
    ).toThrowError(/Manifest path.*con\.md/u);
  });

  it("returns quietly for a safe value", () => {
    expect(() =>
      assertSafeRelativePath("posts/a.md", "Manifest path"),
    ).not.toThrow();
  });
});

describe("case and normalisation collisions", () => {
  it("finds two paths that differ only by case", () => {
    expect(findCaseInsensitiveCollision(["A.md", "a.md"])).toEqual({
      a: "A.md",
      b: "a.md",
      folded: "a.md",
    });
  });

  it("finds two paths that differ only by Unicode normalisation", () => {
    const collision = findCaseInsensitiveCollision(["é.md", "e\u0301.md"]);
    expect(collision?.folded).toBe("é.md");
  });

  it("accepts distinct paths and repeats of the same string", () => {
    expect(findCaseInsensitiveCollision(["a.md", "b.md"])).toBeUndefined();
    expect(findCaseInsensitiveCollision(["a.md", "a.md"])).toBeUndefined();
  });

  it("throws with both paths named", () => {
    expect(() =>
      assertNoCaseCollisions(["A.md", "a.md"], "The release"),
    ).toThrowError(/A\.md and a\.md/u);
  });
});

describe("isInsideDirectory", () => {
  it("is lexical: a sibling with a shared prefix is outside", () => {
    const root = path.join(os.tmpdir(), "safe-paths-root");
    expect(isInsideDirectory(root, path.join(root, "a", "b.md"))).toBe(true);
    expect(isInsideDirectory(root, root)).toBe(true);
    expect(isInsideDirectory(root, `${root}-other`)).toBe(false);
    expect(isInsideDirectory(root, path.join(root, "..", "escape.md"))).toBe(
      false,
    );
  });
});

describe("resolveWithin", () => {
  it("resolves a safe path under the root", () => {
    const root = path.join(os.tmpdir(), "safe-paths-root");
    expect(resolveWithin(root, "a/b.md", "Cache path")).toBe(
      path.join(root, "a", "b.md"),
    );
  });

  it("refuses a path that escapes the root", () => {
    const root = path.join(os.tmpdir(), "safe-paths-root");
    expect(() => resolveWithin(root, "../b.md", "Cache path")).toThrowError(
      ValidationError,
    );
  });

  /**
   * The lexical check cannot see links. A root that is *itself* a link makes
   * every "inside the root" answer a statement about the link's target, so it
   * is refused. Creating a link needs a privilege Windows does not grant by
   * default, hence the probe: on a machine that cannot create one, the rule is
   * untestable rather than broken.
   */
  const linkProbe = ((): { root: string; link: string } | null => {
    const base = mkdtempSync(path.join(os.tmpdir(), "safe-paths-link-"));
    const target = path.join(base, "target");
    const link = path.join(base, "link");
    mkdirSync(target);
    try {
      symlinkSync(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      return { root: base, link };
    } catch {
      rmSync(base, { recursive: true, force: true });
      return null;
    }
  })();

  afterAll(() => {
    if (linkProbe === null) return;
    rmSync(linkProbe.root, { recursive: true, force: true });
  });

  it.skipIf(linkProbe === null)(
    "refuses a root that is itself a symbolic link",
    () => {
      if (linkProbe === null) throw new Error("the link probe did not run");
      expect(() =>
        resolveWithin(linkProbe.link, "a.md", "Cache path"),
      ).toThrowError(ValidationError);
      expect(() =>
        resolveWithin(linkProbe.link, "a.md", "Cache path"),
      ).toThrowError(/symbolic link/u);
    },
  );

  it("allows a root that does not exist yet", () => {
    const missing = path.join(
      os.tmpdir(),
      `safe-paths-missing-${Date.now().toString(36)}`,
    );
    expect(resolveWithin(missing, "a.md", "Cache path")).toBe(
      path.join(missing, "a.md"),
    );
  });
});

describe("isMediaObjectPath", () => {
  const sha = "a".repeat(64);

  it("accepts a content-addressed media path and nothing else", () => {
    expect(isMediaObjectPath(`/media/${sha}/1600.webp`)).toBe(true);
    expect(isMediaObjectPath(`/media/${sha}/original.png`)).toBe(true);
    expect(isMediaObjectPath(`/media/${"A".repeat(64)}/1600.webp`)).toBe(false);
    expect(isMediaObjectPath(`/media/${sha}/sub/1600.webp`)).toBe(false);
    expect(isMediaObjectPath(`media/${sha}/1600.webp`)).toBe(false);
  });

  it("holds the file name to the same rules as any other path", () => {
    // A manifest is untrusted input, and these are names it must not be able to
    // put into a release.
    expect(isMediaObjectPath(`/media/${sha}/con.md`)).toBe(false);
    expect(isMediaObjectPath(`/media/${sha}/a:b.webp`)).toBe(false);
    expect(isMediaObjectPath(`/media/${sha}/${"n".repeat(256)}.webp`)).toBe(
      false,
    );
  });
});
