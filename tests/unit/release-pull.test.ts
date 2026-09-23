import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pathExists } from "../../scripts/lib/fs-util";
import { sha256Hex } from "../../scripts/release/digest";
import {
  MARKDOWN_CONTENT_TYPE,
  buildManifest,
  contentObjectKey,
  manifestObjectKey,
} from "../../scripts/release/manifest";
import { pullRelease, readVerifiedCache } from "../../scripts/release/pull";
import { MemoryStorage } from "../../scripts/release/storage";

/**
 * `pullRelease` used to delete the cache entry it was about to replace, which
 * threw away the one copy of the release that could still be read if the swap
 * failed — the rollback `replaceDirectoryAtomically` documents and could no
 * longer perform. The swap failure is injected by wrapping `rename`, because
 * that is the operation the rollback is built on and there is no portable way
 * to make a real directory rename fail on demand.
 */

const renameGuard = vi.hoisted(() => {
  let predicate: ((from: string, to: string) => boolean) | null = null;
  return {
    set(next: ((from: string, to: string) => boolean) | null): void {
      predicate = next;
    },
    shouldFail(from: string, to: string): boolean {
      return predicate !== null && predicate(from, to);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (renameGuard.shouldFail(from, to)) {
        const error: NodeJS.ErrnoException = new Error(
          "injected rename failure",
        );
        error.code = "EPERM";
        throw error;
      }
      await actual.rename(from, to);
    },
  };
});

const NOW = new Date("2026-09-15T00:00:00.000Z");
const BODY = "# hello\n";
const STALE_BODY = "# tampered with\n";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  renameGuard.set(null);
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A bucket holding one complete, verifiable release. */
function buildStorage(): {
  storage: MemoryStorage;
  manifestJson: string;
  releaseId: string;
} {
  const manifest = buildManifest({
    createdAt: NOW,
    baseReleaseId: null,
    files: [
      {
        path: "posts/hello.md",
        sha256: sha256Hex(BODY),
        bytes: Buffer.byteLength(BODY, "utf8"),
        contentType: MARKDOWN_CONTENT_TYPE,
      },
    ],
    media: [],
  });

  const storage = new MemoryStorage("content");
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  storage.seed(manifestObjectKey(manifest.releaseId), manifestJson);
  storage.seed(contentObjectKey(manifest.releaseId, "posts/hello.md"), BODY);

  return { storage, manifestJson, releaseId: manifest.releaseId };
}

/** A cache entry that exists but no longer matches its manifest. */
async function seedUnverifiableCache(
  cacheRoot: string,
  releaseId: string,
  manifestJson: string,
): Promise<string> {
  const directory = path.join(cacheRoot, releaseId);
  await mkdir(path.join(directory, "content", "posts"), { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), manifestJson);
  await writeFile(
    path.join(directory, "content", "posts", "hello.md"),
    STALE_BODY,
  );
  return directory;
}

async function leftoversIn(cacheRoot: string): Promise<string[]> {
  const names = await readdir(cacheRoot);
  return names.filter(
    (name) => name.includes(".previous") || name.includes(".staging"),
  );
}

describe("pullRelease", () => {
  it("rolls a failed swap back to the cache entry that was there", async () => {
    const { storage, manifestJson, releaseId } = buildStorage();
    const cacheRoot = await temporaryDirectory("pull-cache-");
    const target = await seedUnverifiableCache(
      cacheRoot,
      releaseId,
      manifestJson,
    );

    expect(await readVerifiedCache(cacheRoot, releaseId)).toBeNull();

    renameGuard.set(
      (from, to) =>
        path.basename(from).includes(".staging") &&
        path.resolve(to) === path.resolve(target),
    );

    await expect(
      pullRelease({ storage, releaseId, cacheRoot }),
    ).rejects.toThrow(/injected rename failure/u);

    // The old directory is still there, with its old contents: a failed pull
    // leaves the previous state, never nothing.
    expect(await pathExists(target)).toBe(true);
    expect(
      await readFile(path.join(target, "content", "posts", "hello.md"), "utf8"),
    ).toBe(STALE_BODY);
    expect(await leftoversIn(cacheRoot)).toEqual([]);
  });

  it("replaces an unverifiable cache entry with the downloaded release", async () => {
    const { storage, manifestJson, releaseId } = buildStorage();
    const cacheRoot = await temporaryDirectory("pull-cache-");
    await seedUnverifiableCache(cacheRoot, releaseId, manifestJson);

    const pulled = await pullRelease({ storage, releaseId, cacheRoot });

    expect(pulled.fromCache).toBe(false);
    expect(pulled.directory).toBe(path.join(cacheRoot, releaseId));
    expect(
      await readFile(
        path.join(cacheRoot, releaseId, "content", "posts", "hello.md"),
        "utf8",
      ),
    ).toBe(BODY);
    expect(await leftoversIn(cacheRoot)).toEqual([]);
    // And the fresh copy verifies, so the next pull is a cache hit.
    expect(await readVerifiedCache(cacheRoot, releaseId)).not.toBeNull();
  });

  it("revalidates a cache hit online but permits the verified cache offline", async () => {
    const { storage, manifestJson, releaseId } = buildStorage();
    const cacheRoot = await temporaryDirectory("pull-cache-");
    await pullRelease({ storage, releaseId, cacheRoot });

    const missingObject = new MemoryStorage("missing-content-object");
    missingObject.seed(manifestObjectKey(releaseId), manifestJson);
    await expect(
      pullRelease({ storage: missingObject, releaseId, cacheRoot }),
    ).rejects.toThrow(/does not exist/u);

    const offline = await pullRelease({
      storage: missingObject,
      releaseId,
      cacheRoot,
      offline: true,
    });
    expect(offline.fromCache).toBe(true);
    expect(offline.fileCount).toBe(1);
  });

  it("refuses --offline when the cache cannot be verified", async () => {
    const { storage, releaseId } = buildStorage();
    const cacheRoot = await temporaryDirectory("pull-cache-");

    await expect(
      pullRelease({ storage, releaseId, cacheRoot, offline: true }),
    ).rejects.toThrow(/--offline forbids downloading/u);
  });
});
