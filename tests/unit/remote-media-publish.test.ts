import { describe, expect, it } from "vitest";

import { inspectRemoteMedia } from "../../scripts/content/publish";
import type { MediaMeta } from "../../scripts/media/meta";
import { sha256Hex } from "../../scripts/release/digest";
import { MemoryStorage } from "../../scripts/release/storage";

const DIGEST = "a".repeat(64);
const ORIGINAL_PATH = `/media/${DIGEST}/original.png`;
const COVER_PATH = `/media/${DIGEST}/1600.webp`;
const REFERENCES = [{ path: COVER_PATH, sha256: DIGEST }] as const;

function meta(): MediaMeta {
  return {
    schemaVersion: 1,
    sourceSha256: DIGEST,
    mimeType: "image/png",
    kind: "image",
    alt: "cover",
    license: "CC-BY-4.0",
    original: {
      path: ORIGINAL_PATH,
      width: 1,
      height: 1,
      bytes: 3,
      sha256: sha256Hex("abc"),
      format: "png",
    },
    variants: [
      {
        path: COVER_PATH,
        width: 1600,
        height: 900,
        bytes: 4,
        sha256: sha256Hex("data"),
        format: "webp",
      },
    ],
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

describe("publish remote media verification", () => {
  it("rejects a local-style reference when no remote meta exists", async () => {
    const storage = new MemoryStorage("media");
    const result = await inspectRemoteMedia(storage, REFERENCES);

    expect(result.records.size).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain(
      "a local media record is not proof that the asset was uploaded",
    );
  });

  it("requires every object declared by the remote record to exist", async () => {
    const storage = new MemoryStorage("media");
    storage.seed(`media/${DIGEST}/meta.json`, JSON.stringify(meta()));

    const result = await inspectRemoteMedia(storage, REFERENCES);

    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(`media/${DIGEST}/original.png`),
      expect.stringContaining(`media/${DIGEST}/1600.webp`),
    ]);
  });

  it("accepts a complete remote media family and exposes its filenames", async () => {
    const storage = new MemoryStorage("media");
    storage.seed(`media/${DIGEST}/meta.json`, JSON.stringify(meta()));
    storage.seed(`media/${DIGEST}/original.png`, "abc");
    storage.seed(`media/${DIGEST}/1600.webp`, "data");

    const result = await inspectRemoteMedia(storage, REFERENCES);

    expect(result.issues).toEqual([]);
    expect(result.records.get(DIGEST)?.files).toEqual([
      "original.png",
      "1600.webp",
    ]);
  });

  it("rejects a same-size remote object whose sha256 does not match meta", async () => {
    const storage = new MemoryStorage("media");
    storage.seed(`media/${DIGEST}/meta.json`, JSON.stringify(meta()));
    storage.seed(`media/${DIGEST}/original.png`, "abc");
    storage.seed(`media/${DIGEST}/1600.webp`, "xxxx");

    const result = await inspectRemoteMedia(storage, REFERENCES);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain(
      `media/${DIGEST}/1600.webp does not match`,
    );
  });
});
