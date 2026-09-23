import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MediaMeta } from "../../scripts/media/meta";
import { FILE_MAX_BYTES } from "../../scripts/media/signature";
import { sha256Hex } from "../../scripts/release/digest";
import {
  MAX_MEDIA_ASSETS_PER_RELEASE,
  MAX_MEDIA_BYTES_PER_RELEASE,
  MAX_MEDIA_FILES_PER_ASSET,
  pullReleaseMedia,
  readVerifiedMediaCache,
} from "../../scripts/release/media-pull";
import {
  buildManifest,
  type ReleaseManifest,
} from "../../scripts/release/manifest";
import { MemoryStorage } from "../../scripts/release/storage";

const ORIGINAL = Buffer.from("verified original image bytes", "utf8");
const VARIANT = Buffer.from("verified responsive image bytes", "utf8");
const DIGEST = sha256Hex(ORIGINAL);
const ORIGINAL_PATH = `/media/${DIGEST}/original.png`;
const VARIANT_PATH = `/media/${DIGEST}/1600.webp`;

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "media-pull-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function mediaMeta(overrides: Partial<MediaMeta> = {}): MediaMeta {
  return {
    schemaVersion: 1,
    sourceSha256: DIGEST,
    mimeType: "image/png",
    kind: "image",
    alt: "A useful test image",
    license: "CC-BY-4.0",
    original: {
      path: ORIGINAL_PATH,
      width: 1600,
      height: 900,
      bytes: ORIGINAL.byteLength,
      sha256: sha256Hex(ORIGINAL),
      format: "png",
    },
    variants: [
      {
        path: VARIANT_PATH,
        width: 1600,
        height: 900,
        bytes: VARIANT.byteLength,
        sha256: sha256Hex(VARIANT),
        format: "webp",
      },
    ],
    createdAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(reference = VARIANT_PATH): ReleaseManifest {
  return buildManifest({
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    baseReleaseId: null,
    files: [],
    media: [{ path: reference, sha256: DIGEST }],
  });
}

function seedMedia(storage: MemoryStorage, meta = mediaMeta()): void {
  storage.seed(`media/${DIGEST}/meta.json`, `${JSON.stringify(meta)}\n`, {
    contentType: "application/json; charset=utf-8",
  });
  storage.seed(`media/${DIGEST}/original.png`, ORIGINAL, {
    contentType: "image/png",
  });
  storage.seed(`media/${DIGEST}/1600.webp`, VARIANT, {
    contentType: "image/webp",
  });
}

function releaseWithAssets(count: number): ReleaseManifest {
  return {
    ...manifest(),
    media: Array.from({ length: count }, (_, index) => {
      const digest = index.toString(16).padStart(64, "0");
      return { path: `/media/${digest}/original.bin`, sha256: digest };
    }),
  };
}

function imageFamily(variantCount: number): {
  readonly meta: MediaMeta;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
} {
  const payloads = new Map<string, Uint8Array>([[ORIGINAL_PATH, ORIGINAL]]);
  const variants = Array.from({ length: variantCount }, (_, index) => {
    const width = (index + 1) * 100;
    const payload = Buffer.from(`variant-${width}`, "utf8");
    const publicPath = `/media/${DIGEST}/${width}.webp`;
    payloads.set(publicPath, payload);
    return {
      path: publicPath,
      width,
      height: Math.max(1, Math.round((width * 9) / 16)),
      bytes: payload.byteLength,
      sha256: sha256Hex(payload),
      format: "webp",
    };
  });
  return { meta: mediaMeta({ variants }), payloads };
}

function oversizedFamily(digest: string): MediaMeta {
  return {
    schemaVersion: 1,
    sourceSha256: digest,
    mimeType: "image/png",
    kind: "image",
    alt: "A deliberately oversized test family",
    license: "CC-BY-4.0",
    original: {
      path: `/media/${digest}/original.png`,
      width: 1600,
      height: 900,
      bytes: FILE_MAX_BYTES,
      sha256: "1".repeat(64),
      format: "png",
    },
    variants: Array.from({ length: 8 }, (_, index) => {
      const width = (index + 1) * 100;
      return {
        path: `/media/${digest}/${width}.webp`,
        width,
        height: Math.max(1, Math.round((width * 9) / 16)),
        bytes: FILE_MAX_BYTES,
        sha256: "2".repeat(64),
        format: "webp",
      };
    }),
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

describe("pullReleaseMedia", () => {
  it("downloads and verifies a complete media family, then reuses it offline", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const release = manifest();
    seedMedia(storage);

    const pulled = await pullReleaseMedia({
      manifest: release,
      cacheDirectory,
      storage,
    });

    expect(pulled.fromCache).toBe(false);
    expect(pulled.fileCount).toBe(3);
    expect(pulled.index.assets).toHaveLength(1);
    expect(pulled.index.assets[0]).toMatchObject({
      sourceSha256: DIGEST,
      localPath: `media/${DIGEST}/1600.webp`,
      width: 1600,
      height: 900,
    });

    const offline = await pullReleaseMedia({
      manifest: release,
      cacheDirectory,
      offline: true,
    });
    expect(offline.fromCache).toBe(true);
    expect(offline.index).toEqual(pulled.index);
  });

  it("revalidates R2 during an online pull even when the local cache is valid", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const release = manifest();
    seedMedia(storage);

    await pullReleaseMedia({ manifest: release, cacheDirectory, storage });
    await storage.delete(`media/${DIGEST}/1600.webp`);

    await expect(
      pullReleaseMedia({ manifest: release, cacheDirectory, storage }),
    ).rejects.toThrow(/does not exist/u);
  });

  it("refuses a release reference that is absent from meta.json", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    seedMedia(storage);

    await expect(
      pullReleaseMedia({
        manifest: manifest(`/media/${DIGEST}/1200.webp`),
        cacheDirectory,
        storage,
      }),
    ).rejects.toThrow(/not the original or a variant/u);
  });

  it("indexes an audio original without inventing image dimensions", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const audio = Buffer.from("verified audio bytes", "utf8");
    const digest = sha256Hex(audio);
    const audioPath = `/media/${digest}/original.mp3`;
    const audioMeta: MediaMeta = {
      schemaVersion: 1,
      sourceSha256: digest,
      mimeType: "audio/mpeg",
      kind: "audio",
      alt: "An accessible audio clip",
      license: "CC-BY-4.0",
      original: {
        path: audioPath,
        width: null,
        height: null,
        bytes: audio.byteLength,
        sha256: sha256Hex(audio),
        format: "mp3",
      },
      variants: [],
      createdAt: "2026-09-15T00:00:00.000Z",
    };
    const release = buildManifest({
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      baseReleaseId: null,
      files: [],
      media: [{ path: audioPath, sha256: digest }],
    });
    storage.seed(`media/${digest}/meta.json`, JSON.stringify(audioMeta));
    storage.seed(`media/${digest}/original.mp3`, audio);

    const pulled = await pullReleaseMedia({
      manifest: release,
      cacheDirectory,
      storage,
    });

    expect(pulled.index.assets).toEqual([
      expect.objectContaining({
        sourceSha256: digest,
        kind: "audio",
        width: null,
        height: null,
        localPath: `media/${digest}/original.mp3`,
        derivatives: [
          expect.objectContaining({
            width: 0,
            format: "original",
            path: audioPath,
          }),
        ],
      }),
    ]);
  });

  it("allows exactly the supported ten files in one image family", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const family = imageFamily(MAX_MEDIA_FILES_PER_ASSET - 2);
    const release = buildManifest({
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      baseReleaseId: null,
      files: [],
      media: [{ path: ORIGINAL_PATH, sha256: DIGEST }],
    });
    storage.seed(`media/${DIGEST}/meta.json`, JSON.stringify(family.meta));
    for (const [publicPath, payload] of family.payloads) {
      storage.seed(publicPath.slice(1), payload);
    }

    const pulled = await pullReleaseMedia({
      manifest: release,
      cacheDirectory,
      storage,
    });

    expect(pulled.fileCount).toBe(MAX_MEDIA_FILES_PER_ASSET);
  });

  it.each(["online", "offline"] as const)(
    "rejects an asset above the file-count limit in %s mode",
    async (mode) => {
      const cacheDirectory = await temporaryDirectory();
      const family = imageFamily(MAX_MEDIA_FILES_PER_ASSET - 1);
      const release = buildManifest({
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        baseReleaseId: null,
        files: [],
        media: [{ path: ORIGINAL_PATH, sha256: DIGEST }],
      });
      const storage = new MemoryStorage("media");
      storage.seed(`media/${DIGEST}/meta.json`, JSON.stringify(family.meta));

      if (mode === "offline") {
        const mediaDirectory = path.join(cacheDirectory, "media", DIGEST);
        await mkdir(mediaDirectory, { recursive: true });
        await writeFile(
          path.join(mediaDirectory, "meta.json"),
          JSON.stringify(family.meta),
        );
      }

      await expect(
        pullReleaseMedia({
          manifest: release,
          cacheDirectory,
          ...(mode === "online" ? { storage } : { offline: true }),
        }),
      ).rejects.toThrow(
        new RegExp(`at most ${MAX_MEDIA_FILES_PER_ASSET}`, "u"),
      );
    },
  );

  it("permits the exact release asset-count boundary to reach remote verification", async () => {
    const cacheDirectory = await temporaryDirectory();
    await expect(
      pullReleaseMedia({
        manifest: releaseWithAssets(MAX_MEDIA_ASSETS_PER_RELEASE),
        cacheDirectory,
        storage: new MemoryStorage("empty-media"),
      }),
    ).rejects.toThrow(/meta\.json does not exist/u);
  });

  it.each(["online", "offline"] as const)(
    "rejects too many distinct release assets in %s mode",
    async (mode) => {
      const cacheDirectory = await temporaryDirectory();
      await expect(
        pullReleaseMedia({
          manifest: releaseWithAssets(MAX_MEDIA_ASSETS_PER_RELEASE + 1),
          cacheDirectory,
          ...(mode === "online"
            ? { storage: new MemoryStorage("media") }
            : { offline: true }),
        }),
      ).rejects.toThrow(
        new RegExp(
          `more than ${MAX_MEDIA_ASSETS_PER_RELEASE} distinct media assets`,
          "u",
        ),
      );
    },
  );

  it.each(["online", "offline"] as const)(
    "rejects a release above the aggregate byte limit in %s mode",
    async (mode) => {
      const cacheDirectory = await temporaryDirectory();
      const digests = ["a".repeat(64), "b".repeat(64)];
      const records = digests.map((digest) => oversizedFamily(digest));
      const release: ReleaseManifest = {
        ...manifest(),
        media: records.map((record) => ({
          path: record.original.path,
          sha256: record.sourceSha256,
        })),
      };
      const storage = new MemoryStorage("media");

      for (const record of records) {
        const relative = `media/${record.sourceSha256}/meta.json`;
        storage.seed(relative, JSON.stringify(record));
        if (mode === "offline") {
          const mediaDirectory = path.join(
            cacheDirectory,
            "media",
            record.sourceSha256,
          );
          await mkdir(mediaDirectory, { recursive: true });
          await writeFile(
            path.join(mediaDirectory, "meta.json"),
            JSON.stringify(record),
          );
        }
      }

      expect(FILE_MAX_BYTES * 9 * records.length).toBeGreaterThan(
        MAX_MEDIA_BYTES_PER_RELEASE,
      );
      await expect(
        pullReleaseMedia({
          manifest: release,
          cacheDirectory,
          ...(mode === "online" ? { storage } : { offline: true }),
        }),
      ).rejects.toThrow(
        new RegExp(
          `above the ${MAX_MEDIA_BYTES_PER_RELEASE}-byte .* build limit`,
          "u",
        ),
      );
    },
  );

  it("refuses remote bytes that do not match the record hash", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const invalid = mediaMeta({
      variants: [
        {
          path: VARIANT_PATH,
          width: 1600,
          height: 900,
          bytes: VARIANT.byteLength,
          sha256: "0".repeat(64),
          format: "webp",
        },
      ],
    });
    seedMedia(storage, invalid);

    await expect(
      pullReleaseMedia({
        manifest: manifest(),
        cacheDirectory,
        storage,
      }),
    ).rejects.toThrow(/hashes to/u);
  });

  it("treats a changed cached object as invalid and fails closed offline", async () => {
    const cacheDirectory = await temporaryDirectory();
    const storage = new MemoryStorage("media");
    const release = manifest();
    seedMedia(storage);
    const pulled = await pullReleaseMedia({
      manifest: release,
      cacheDirectory,
      storage,
    });
    expect(pulled.directory).not.toBeNull();
    await writeFile(
      path.join(pulled.directory!, DIGEST, "1600.webp"),
      "changed",
    );

    expect(await readVerifiedMediaCache(cacheDirectory, release)).toBeNull();
    await expect(
      pullReleaseMedia({
        manifest: release,
        cacheDirectory,
        offline: true,
      }),
    ).rejects.toThrow(/--offline forbids downloading/u);
  });
});
