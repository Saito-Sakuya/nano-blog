import { describe, expect, it } from "vitest";

import {
  assertPlanActionable,
  cleanupPlanDigest,
  planCleanup,
  type CleanupInput,
  type ReleaseInventory,
} from "../../scripts/release/cleanup-plan";
import { sha256Hex } from "../../scripts/release/digest";
import {
  collectInventory,
  toCleanupInput,
} from "../../scripts/release/inventory";
import {
  MARKDOWN_CONTENT_TYPE,
  buildManifest,
  contentObjectKey,
  manifestObjectKey,
} from "../../scripts/release/manifest";
import { MemoryStorage } from "../../scripts/release/storage";

/**
 * The protection set for media comes from manifests. When one cannot be read
 * the release it belongs to can still survive — the active release always does,
 * and so does anything under 90 days old — so the media it references is
 * unknown and every media deletion has to be withheld. These tests are the
 * fail-closed rule from both sides: it fires for a retained release, and it does
 * not fire for a release that is going away anyway.
 */

const NOW = new Date("2026-09-15T00:00:00.000Z");
/** Over 90 days before `NOW`, so nothing keeps it for its age. */
const OLD = new Date("2026-01-01T00:00:00.000Z");
/** One day before `NOW`, so the age rule keeps it whatever its manifest says. */
const YOUNG = new Date("2026-09-14T00:00:00.000Z");

const REFERENCED_SHA = "b".repeat(64);
const UNREFERENCED_SHA = "c".repeat(64);
const REFERENCED_KEY = `media/${REFERENCED_SHA}/1600.webp`;
const UNREFERENCED_KEY = `media/${UNREFERENCED_SHA}/800.webp`;
const COVER_PATH = `/media/${REFERENCED_SHA}/1600.webp`;

/** A release id for a hand-written manifest, so it parses as a real id. */
const OLD_RELEASE = "20260101T000000Z-0123456789ab";
const YOUNG_RELEASE = "20260914T000000Z-0123456789ab";

const BODY = "# hello\n";

function seedWithClock(
  storage: MemoryStorage,
  instant: Date,
  seed: () => void,
): void {
  storage.setClock(() => instant);
  try {
    seed();
  } finally {
    storage.setClock(() => NOW);
  }
}

/** A complete release: a valid manifest plus one content file. */
function seedRelease(
  storage: MemoryStorage,
  createdAt: Date,
  options: { readonly media?: readonly string[] } = {},
): string {
  const manifest = buildManifest({
    createdAt,
    baseReleaseId: null,
    files: [
      {
        path: "posts/hello.md",
        sha256: sha256Hex(BODY),
        bytes: Buffer.byteLength(BODY, "utf8"),
        contentType: MARKDOWN_CONTENT_TYPE,
      },
    ],
    media: (options.media ?? []).map((path) => ({
      path,
      sha256: path.split("/")[2] ?? "",
    })),
  });

  seedWithClock(storage, createdAt, () => {
    storage.seed(
      manifestObjectKey(manifest.releaseId),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    storage.seed(contentObjectKey(manifest.releaseId, "posts/hello.md"), BODY);
  });

  return manifest.releaseId;
}

/** A release whose manifest exists but cannot be parsed. */
function seedUnreadableRelease(
  storage: MemoryStorage,
  releaseId: string,
  written: Date,
): void {
  seedWithClock(storage, written, () => {
    storage.seed(`releases/${releaseId}/manifest.json`, "{ this is not json\n");
    storage.seed(`releases/${releaseId}/content/posts/hello.md`, BODY);
  });
}

/** An interrupted upload: objects under a release prefix, no manifest. */
function seedAbandonedUpload(
  storage: MemoryStorage,
  releaseId: string,
  written: Date,
): void {
  seedWithClock(storage, written, () => {
    storage.seed(`releases/${releaseId}/content/posts/hello.md`, BODY);
  });
}

function seedMedia(storage: MemoryStorage, key: string, written: Date): void {
  seedWithClock(storage, written, () => {
    storage.seed(key, "bytes");
  });
}

async function planFor(options: {
  readonly content: MemoryStorage;
  readonly media: MemoryStorage;
  readonly activeReleaseId?: string | null;
}): Promise<ReturnType<typeof planCleanup>> {
  const inventory = await collectInventory({
    content: options.content,
    media: options.media,
    activeReleaseId: options.activeReleaseId ?? null,
  });
  return planCleanup(toCleanupInput(inventory, NOW));
}

describe("collectInventory", () => {
  it("records a valid manifest and the media it references", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    const releaseId = seedRelease(content, OLD, { media: [COVER_PATH] });
    seedMedia(media, REFERENCED_KEY, OLD);

    const inventory = await collectInventory({
      content,
      media,
      activeReleaseId: null,
    });

    expect(inventory.releases).toHaveLength(1);
    expect(inventory.releases[0]?.releaseId).toBe(releaseId);
    expect(inventory.releases[0]?.manifestState).toBe("valid");
    expect(inventory.releases[0]?.referencedMedia).toEqual([COVER_PATH]);
    expect(inventory.releases[0]?.objects.map((object) => object.key)).toEqual([
      contentObjectKey(releaseId, "posts/hello.md"),
      manifestObjectKey(releaseId),
    ]);
  });

  it("records a manifest that cannot be parsed as unreadable, and warns", async () => {
    const content = new MemoryStorage("content");
    seedUnreadableRelease(content, YOUNG_RELEASE, YOUNG);
    const warnings: string[] = [];

    const inventory = await collectInventory({
      content,
      media: new MemoryStorage("media"),
      activeReleaseId: null,
      onProgress: (message) => warnings.push(message),
    });

    expect(inventory.releases[0]?.manifestState).toBe("unreadable");
    expect(inventory.releases[0]?.referencedMedia).toEqual([]);
    expect(warnings.join("\n")).toContain("could not be read");
  });

  it("records a manifest that declares the wrong release as unreadable", async () => {
    const content = new MemoryStorage("content");
    // A perfectly valid manifest, filed under somebody else's release id.
    const built = buildManifest({
      createdAt: OLD,
      baseReleaseId: null,
      files: [],
      media: [],
    });
    const wrongId = "20260101T000000Z-ffffffffffff";
    seedWithClock(content, OLD, () => {
      content.seed(manifestObjectKey(wrongId), JSON.stringify(built));
    });
    const warnings: string[] = [];

    const inventory = await collectInventory({
      content,
      media: new MemoryStorage("media"),
      activeReleaseId: null,
      onProgress: (message) => warnings.push(message),
    });

    expect(inventory.releases[0]?.manifestState).toBe("unreadable");
    expect(warnings.join("\n")).toContain("declares release");
  });

  it("records a release with no manifest object as missing, without a warning", async () => {
    const content = new MemoryStorage("content");
    seedAbandonedUpload(content, YOUNG_RELEASE, YOUNG);
    const warnings: string[] = [];

    const inventory = await collectInventory({
      content,
      media: new MemoryStorage("media"),
      activeReleaseId: null,
      onProgress: (message) => warnings.push(message),
    });

    expect(inventory.releases[0]?.manifestState).toBe("missing");
    expect(
      warnings.filter((line) => line.includes("could not be read")),
    ).toEqual([]);
  });
});

describe("planCleanup with usable manifests", () => {
  it("keeps referenced media and deletes unreferenced old media", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedRelease(content, OLD, { media: [COVER_PATH] });
    seedMedia(media, REFERENCED_KEY, OLD);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({ content, media });

    expect(plan.incomplete).toBeNull();
    expect(plan.keepMedia).toEqual([REFERENCED_KEY]);
    expect(plan.mediaDeletes.map((object) => object.key)).toEqual([
      UNREFERENCED_KEY,
    ]);
  });

  it("keeps the complete media family when one derivative is referenced", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedRelease(content, OLD, { media: [COVER_PATH] });

    const family = [
      REFERENCED_KEY,
      `media/${REFERENCED_SHA}/meta.json`,
      `media/${REFERENCED_SHA}/480.webp`,
      `media/${REFERENCED_SHA}/800.avif`,
      `media/${REFERENCED_SHA}/original.png`,
    ];
    for (const key of family) seedMedia(media, key, OLD);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({ content, media });

    expect(plan.incomplete).toBeNull();
    expect(plan.keepMedia).toEqual([REFERENCED_KEY]);
    expect(plan.mediaDeletes.map((object) => object.key)).toEqual([
      UNREFERENCED_KEY,
    ]);
  });

  it("does not delete young media even when nothing references it", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedMedia(media, UNREFERENCED_KEY, YOUNG);

    const plan = await planFor({ content, media });

    expect(plan.incomplete).toBeNull();
    expect(plan.mediaDeletes).toEqual([]);
  });
});

describe("planCleanup with an unusable manifest", () => {
  it("withholds every media deletion for the active release", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedUnreadableRelease(content, OLD_RELEASE, OLD);
    seedMedia(media, REFERENCED_KEY, OLD);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({
      content,
      media,
      activeReleaseId: OLD_RELEASE,
    });

    // The active release is retained, so it is not deleted either — and the
    // media it references is exactly what used to be deleted.
    expect(plan.retained).toEqual([OLD_RELEASE]);
    expect(plan.contentDeletes).toEqual([]);
    expect(plan.mediaDeletes).toEqual([]);
    expect(plan.incomplete?.releases).toEqual([OLD_RELEASE]);
    expect(plan.incomplete?.reason).toContain("Repair manifest access first");
    expect(() => assertPlanActionable(plan)).toThrow(/no readable manifest/u);
  });

  it("withholds every media deletion for a young release", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedUnreadableRelease(content, YOUNG_RELEASE, YOUNG);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({ content, media });

    expect(plan.mediaDeletes).toEqual([]);
    expect(plan.incomplete?.releases).toEqual([YOUNG_RELEASE]);
    expect(() => assertPlanActionable(plan)).toThrow(
      new RegExp(YOUNG_RELEASE, "u"),
    );
  });

  it("withholds media deletion for a young release with no manifest at all", async () => {
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedAbandonedUpload(content, YOUNG_RELEASE, YOUNG);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({ content, media });

    expect(plan.mediaDeletes).toEqual([]);
    expect(plan.incomplete?.releases).toEqual([YOUNG_RELEASE]);
  });

  it("does not block on an old release that has no usable manifest", async () => {
    // The release is going away, so what its manifest might have referenced
    // cannot protect anything — and must not stop the cleanup either.
    const content = new MemoryStorage("content");
    const media = new MemoryStorage("media");
    seedAbandonedUpload(content, OLD_RELEASE, OLD);
    seedMedia(media, UNREFERENCED_KEY, OLD);

    const plan = await planFor({ content, media });

    expect(plan.incomplete).toBeNull();
    expect(plan.retained).toEqual([]);
    expect(plan.contentDeletes.map((object) => object.key)).toEqual([
      `releases/${OLD_RELEASE}/content/posts/hello.md`,
    ]);
    expect(plan.mediaDeletes.map((object) => object.key)).toEqual([
      UNREFERENCED_KEY,
    ]);
  });
});

describe("cleanupPlanDigest", () => {
  it("distinguishes a plan whose media deletions were withheld", () => {
    const release: Omit<ReleaseInventory, "manifestState"> = {
      releaseId: YOUNG_RELEASE,
      objects: [],
      referencedMedia: [],
    };
    const base: Omit<CleanupInput, "releases"> = {
      activeReleaseId: null,
      contentObjects: [],
      mediaObjects: [],
      now: NOW,
    };

    const blocked = planCleanup({
      ...base,
      releases: [{ ...release, manifestState: "unreadable" }],
    });
    const usable = planCleanup({
      ...base,
      releases: [{ ...release, manifestState: "valid" }],
    });

    // Same retained set, same (empty) deletions — and still not the same plan.
    expect(blocked.retained).toEqual(usable.retained);
    expect(blocked.contentDeletes).toEqual(usable.contentDeletes);
    expect(blocked.mediaDeletes).toEqual(usable.mediaDeletes);
    expect(cleanupPlanDigest(blocked)).not.toBe(cleanupPlanDigest(usable));
    expect(() => assertPlanActionable(usable)).not.toThrow();
  });
});
