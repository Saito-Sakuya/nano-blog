import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "../../scripts/lib/errors";
import {
  copyFileEntries,
  pathExists,
  type FileEntry,
} from "../../scripts/lib/fs-util";

/**
 * `copyFileEntries` decides what a build materialises, and it used to validate
 * one path while reading another: `relativePath` went through every check and
 * `absolutePath` was what got read, so an entry pairing a harmless relative path
 * with any absolute path copied the file it named. The tests below pin the two
 * halves together.
 */

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("copyFileEntries", () => {
  it("reads the file its relativePath names when a sourceRoot is given", async () => {
    const root = await temporaryDirectory("fs-util-root-");
    const elsewhere = await temporaryDirectory("fs-util-elsewhere-");
    const target = await temporaryDirectory("fs-util-target-");

    await writeFile(path.join(root, "a.md"), "# from the root\n");
    await writeFile(path.join(elsewhere, "b.md"), "# from somewhere else\n");

    const entry: FileEntry = {
      relativePath: "a.md",
      // A hand-built entry claiming a different file: the source must be the
      // one `relativePath` resolves to, not this.
      absolutePath: path.join(elsewhere, "b.md"),
      bytes: 12,
    };

    await copyFileEntries(target, [entry], { sourceRoot: root });

    expect(await readFile(path.join(target, "a.md"), "utf8")).toBe(
      "# from the root\n",
    );
  });

  it("refuses an entry whose absolutePath disagrees with its relativePath", async () => {
    const target = await temporaryDirectory("fs-util-target-");

    const crafted: FileEntry = {
      relativePath: "posts/a.md",
      absolutePath:
        process.platform === "win32"
          ? "C:/Windows/System32/drivers/etc/hosts"
          : "/etc/hosts",
      bytes: 12,
    };

    await expect(copyFileEntries(target, [crafted])).rejects.toThrow(
      ValidationError,
    );
    await expect(copyFileEntries(target, [crafted])).rejects.toThrow(
      /does not match its own absolute path/u,
    );
    expect(await pathExists(path.join(target, "posts", "a.md"))).toBe(false);
  });

  it("accepts an entry that describes itself consistently", async () => {
    const root = await temporaryDirectory("fs-util-root-");
    const target = await temporaryDirectory("fs-util-target-");

    await writeFile(path.join(root, "a.md"), "# consistent\n");
    const entry: FileEntry = {
      relativePath: "a.md",
      absolutePath: path.join(root, "a.md"),
      bytes: 13,
    };

    await copyFileEntries(target, [entry]);

    expect(await readFile(path.join(target, "a.md"), "utf8")).toBe(
      "# consistent\n",
    );
  });

  it("creates the destination directories a nested path needs", async () => {
    const root = await temporaryDirectory("fs-util-root-");
    const target = await temporaryDirectory("fs-util-target-");

    await mkdir(path.join(root, "posts", "dev"), { recursive: true });
    await writeFile(path.join(root, "posts", "dev", "a.md"), "# nested\n");

    await copyFileEntries(
      target,
      [
        {
          relativePath: "posts/dev/a.md",
          absolutePath: path.join(root, "posts", "dev", "a.md"),
          bytes: 8,
        },
      ],
      { sourceRoot: root },
    );

    expect(
      await readFile(path.join(target, "posts", "dev", "a.md"), "utf8"),
    ).toBe("# nested\n");
  });

  it("refuses a file above maxBytes before reading it", async () => {
    const root = await temporaryDirectory("fs-util-root-");
    const target = await temporaryDirectory("fs-util-target-");

    await writeFile(path.join(root, "big.md"), "x".repeat(64));

    await expect(
      copyFileEntries(
        target,
        [
          {
            relativePath: "big.md",
            absolutePath: path.join(root, "big.md"),
            bytes: 64,
          },
        ],
        { sourceRoot: root, maxBytes: 8 },
      ),
    ).rejects.toThrow(/above the 8-byte limit/u);

    expect(await pathExists(path.join(target, "big.md"))).toBe(false);
  });

  it("refuses a relative path that escapes the target", async () => {
    const root = await temporaryDirectory("fs-util-root-");
    const target = await temporaryDirectory("fs-util-target-");

    await expect(
      copyFileEntries(
        target,
        [
          {
            relativePath: "../escape.md",
            absolutePath: path.join(root, "escape.md"),
            bytes: 1,
          },
        ],
        { sourceRoot: root },
      ),
    ).rejects.toThrow(ValidationError);
  });
});
