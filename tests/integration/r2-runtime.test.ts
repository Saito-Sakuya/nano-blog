import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MediaIndex } from "../../src/lib/media/index";
import { sha256Hex } from "../../scripts/release/digest";
import { pullReleaseMedia } from "../../scripts/release/media-pull";
import {
  MARKDOWN_CONTENT_TYPE,
  buildManifest,
} from "../../scripts/release/manifest";
import { materializeRuntime } from "../../scripts/release/pull";
import { MemoryStorage } from "../../scripts/release/storage";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "r2-runtime-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("R2 runtime materialisation", () => {
  it("commits content, verified media, index and source record in one runtime", async () => {
    const root = await temporaryRoot();
    const contentDir = path.join(root, "source-content");
    const runtimeDir = path.join(root, "runtime");
    const cacheDirectory = path.join(root, "release-cache");
    const body = Buffer.from("---\ntitle: Hello\n---\n\nBody\n", "utf8");
    await mkdir(path.join(contentDir, "posts"), { recursive: true });
    await writeFile(path.join(contentDir, "posts", "hello.md"), body);

    const original = Buffer.from("original image", "utf8");
    const variant = Buffer.from("cover image", "utf8");
    const digest = sha256Hex(original);
    const coverPath = `/media/${digest}/1600.webp`;
    const meta = {
      schemaVersion: 1,
      sourceSha256: digest,
      mimeType: "image/png",
      kind: "image",
      alt: "A complete R2 cover",
      license: "CC-BY-4.0",
      original: {
        path: `/media/${digest}/original.png`,
        width: 1600,
        height: 900,
        bytes: original.byteLength,
        sha256: sha256Hex(original),
        format: "png",
      },
      variants: [
        {
          path: coverPath,
          width: 1600,
          height: 900,
          bytes: variant.byteLength,
          sha256: sha256Hex(variant),
          format: "webp",
        },
      ],
      createdAt: "2026-09-15T00:00:00.000Z",
    } as const;

    const manifest = buildManifest({
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      baseReleaseId: null,
      files: [
        {
          path: "posts/hello.md",
          sha256: sha256Hex(body),
          bytes: body.byteLength,
          contentType: MARKDOWN_CONTENT_TYPE,
        },
      ],
      media: [{ path: coverPath, sha256: digest }],
    });

    const storage = new MemoryStorage("media");
    storage.seed(`media/${digest}/meta.json`, JSON.stringify(meta));
    storage.seed(`media/${digest}/original.png`, original);
    storage.seed(`media/${digest}/1600.webp`, variant);
    const media = await pullReleaseMedia({
      manifest,
      cacheDirectory,
      storage,
    });

    const result = await materializeRuntime({
      sourceContentDir: contentDir,
      runtimeDir,
      root,
      mode: "r2",
      releaseId: manifest.releaseId,
      contentDigest: manifest.contentDigest,
      instant: new Date("2026-09-15T01:00:00.000Z"),
      media: { sourceDir: media.directory, index: media.index },
    });

    expect(result.fileCount).toBe(1);
    expect(result.mediaFileCount).toBe(3);
    expect(
      await readFile(path.join(runtimeDir, "content", "posts", "hello.md")),
    ).toEqual(body);
    expect(
      await readFile(path.join(runtimeDir, "media", digest, "1600.webp")),
    ).toEqual(variant);
    expect(
      JSON.parse(
        await readFile(path.join(runtimeDir, "media-index.json"), "utf8"),
      ),
    ).toEqual(media.index);
    expect(
      JSON.parse(await readFile(path.join(runtimeDir, "source.json"), "utf8")),
    ).toMatchObject({
      mode: "r2",
      releaseId: manifest.releaseId,
      contentDigest: manifest.contentDigest,
    });
  });

  it("keeps the previous runtime when media and index disagree", async () => {
    const root = await temporaryRoot();
    const contentDir = path.join(root, "source-content");
    const mediaDir = path.join(root, "source-media");
    const runtimeDir = path.join(root, "runtime");
    await mkdir(path.join(contentDir, "posts"), { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(contentDir, "posts", "new.md"), "new");
    await writeFile(path.join(mediaDir, "meta.json"), "{}");
    await writeFile(path.join(runtimeDir, "previous.txt"), "still here");

    const digest = "1".repeat(64);
    const index: MediaIndex = {
      schemaVersion: 1,
      assets: [
        {
          sourceSha256: digest,
          kind: "image",
          mime: "image/webp",
          alt: "Missing local cover",
          width: 1600,
          height: 900,
          bytes: 4,
          license: "CC-BY-4.0",
          localPath: `media/${digest}/1600.webp`,
          derivatives: [],
        },
      ],
    };

    await expect(
      materializeRuntime({
        sourceContentDir: contentDir,
        runtimeDir,
        root,
        mode: "r2",
        releaseId: "20260915T000000Z-111111111111",
        contentDigest: `sha256:${"1".repeat(64)}`,
        instant: new Date("2026-09-15T01:00:00.000Z"),
        media: { sourceDir: mediaDir, index },
      }),
    ).rejects.toThrow(/not present in the verified media directory/u);

    expect(await readFile(path.join(runtimeDir, "previous.txt"), "utf8")).toBe(
      "still here",
    );
    await expect(
      readFile(path.join(runtimeDir, "content", "posts", "new.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
