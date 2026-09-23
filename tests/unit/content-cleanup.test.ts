import { describe, expect, it } from "vitest";

import { runCleanup } from "../../scripts/content/cleanup";
import { Environment } from "../../scripts/lib/env";
import { EXIT, RemoteError } from "../../scripts/lib/errors";
import type { ImageProcessor } from "../../scripts/media/processor";
import {
  cleanupPlanDigest,
  planCleanup,
} from "../../scripts/release/cleanup-plan";
import { DryRunDeployHook } from "../../scripts/release/deploy";
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
import { acquireMutationLease } from "../../scripts/release/lease";
import {
  createFixedPortsFactory,
  type ReleasePorts,
} from "../../scripts/release/ports";
import { sha256Hex } from "../../scripts/release/digest";
import {
  MemoryStorage,
  type MutationCounter,
  type ObjectData,
  type ObjectHead,
  type ObjectSummary,
  type PutOptions,
  type PutResult,
  type StorageAdapter,
} from "../../scripts/release/storage";

/**
 * `content:cleanup --apply` is the only destructive command in the project. Two
 * properties are pinned here:
 *
 * - a delete whose outcome cannot be confirmed is a *failure*, not a success —
 *   a HEAD that errors is not the same answer as a HEAD that says 404;
 * - a plan whose media deletions were withheld is never applied, whatever
 *   digest is supplied.
 */

const NOW = new Date("2026-09-15T00:00:00.000Z");
/** Over 90 days before `NOW`. */
const OLD = new Date("2026-01-01T00:00:00.000Z");

/** An old, manifestless release: nothing retains it, so it is deletable. */
const ABANDONED_RELEASE = "20260101T000000Z-0123456789ab";
const ABANDONED_KEY = `releases/${ABANDONED_RELEASE}/content/posts/hello.md`;

/** A young release whose manifest does not parse: retained, so it blocks. */
const BROKEN_RELEASE = "20260914T000000Z-0123456789ab";
const BROKEN_MANIFEST_KEY = manifestObjectKey(BROKEN_RELEASE);

const MEDIA_SHA = "c".repeat(64);
const MEDIA_KEY = `media/${MEDIA_SHA}/800.webp`;
const BODY = "# hello\n";

const stubImages: ImageProcessor = {
  label: "test image pipeline (unused by cleanup)",
  metadata: async () => ({
    width: 1,
    height: 1,
    format: "png",
    hasAlpha: false,
  }),
  stats: async () => ({ stdev: [0], uniqueColours: 0, entropy: 0 }),
  sanitize: async (bytes) => bytes,
  derive: async (bytes, options) => ({
    width: options.width,
    height: options.width,
    format: options.format,
    bytes,
  }),
};

function withClock(
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

/** A valid, old release that the ten-most-recent rule keeps. */
function seedRetainedRelease(storage: MemoryStorage): string {
  const manifest = buildManifest({
    createdAt: OLD,
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

  withClock(storage, OLD, () => {
    storage.seed(
      manifestObjectKey(manifest.releaseId),
      JSON.stringify(manifest),
    );
    storage.seed(contentObjectKey(manifest.releaseId, "posts/hello.md"), BODY);
  });

  return manifest.releaseId;
}

/** An interrupted upload, old enough that nothing keeps it. */
function seedAbandonedUpload(storage: MemoryStorage): void {
  withClock(storage, OLD, () => {
    storage.seed(ABANDONED_KEY, BODY);
  });
}

type HeadBehaviour = "inner" | "throw";

/**
 * A storage adapter whose deletes fail, with a configurable re-read.
 *
 * `delete` removes the object only when `effectApplied` is set — a request whose
 * response was lost after the bucket acted on it — and always throws, which is
 * the only thing the cleanup command sees.
 */
class FailingDeleteStorage implements StorageAdapter {
  readonly inner: MemoryStorage;
  readonly #effectApplied: boolean;
  readonly #headBehaviour: (key: string) => HeadBehaviour;
  readonly deleted: string[] = [];

  constructor(
    inner: MemoryStorage,
    options: {
      readonly effectApplied: boolean;
      readonly headBehaviour?: (key: string) => HeadBehaviour;
    },
  ) {
    this.inner = inner;
    this.#effectApplied = options.effectApplied;
    this.#headBehaviour = options.headBehaviour ?? (() => "inner");
  }

  get label(): string {
    return this.inner.label;
  }

  get mutations(): MutationCounter {
    return this.inner.mutations;
  }

  list(prefix: string): AsyncIterable<ObjectSummary> {
    return this.inner.list(prefix);
  }

  head(key: string): Promise<ObjectHead | null> {
    if (this.#headBehaviour(key) === "throw") {
      return Promise.reject(
        new RemoteError(`${this.label}: HEAD ${key} failed`),
      );
    }
    return this.inner.head(key);
  }

  get(key: string, options: { maxBytes?: number } = {}): Promise<ObjectData> {
    return this.inner.get(key, options);
  }

  put(key: string, body: Uint8Array, options: PutOptions): Promise<PutResult> {
    return this.inner.put(key, body, options);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    if (this.#effectApplied) await this.inner.delete(key);
    throw new RemoteError(`${this.label}: delete ${key} failed`);
  }
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: readonly string[],
  ports: ReleasePorts,
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCleanup(argv, {
    env: new Environment({}),
    now: () => NOW,
    ports: createFixedPortsFactory(ports),
    images: stubImages,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function portsFor(
  content: StorageAdapter,
  media: StorageAdapter,
): ReleasePorts {
  return {
    content,
    media,
    deploy: new DryRunDeployHook(),
    description: "test ports",
  };
}

async function digestFor(
  content: MemoryStorage,
  media: MemoryStorage,
): Promise<string> {
  const inventory = await collectInventory({
    content,
    media,
    activeReleaseId: null,
  });
  return cleanupPlanDigest(planCleanup(toCleanupInput(inventory, NOW)));
}

describe("content:cleanup --apply", () => {
  it("counts a delete whose re-read reports the object is gone as a success", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedAbandonedUpload(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    const content = new FailingDeleteStorage(contentStore, {
      effectApplied: true,
    });
    const media = new FailingDeleteStorage(mediaStore, { effectApplied: true });
    const digest = await digestFor(contentStore, mediaStore);

    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(content, media),
    );

    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("the object is gone");
    expect(await mediaStore.head(MEDIA_KEY)).toBeNull();
    expect(await contentStore.head(ABANDONED_KEY)).toBeNull();
  });

  it("counts a delete whose re-read still finds the object as a failure", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedAbandonedUpload(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    const content = new FailingDeleteStorage(contentStore, {
      effectApplied: false,
    });
    const media = new FailingDeleteStorage(mediaStore, {
      effectApplied: false,
    });
    const digest = await digestFor(contentStore, mediaStore);

    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(content, media),
    );

    expect(result.code).toBe(EXIT.REMOTE);
    expect(result.stdout).not.toContain("the object is gone");
    expect(result.stdout).toContain("2 could not be deleted");
    expect(result.stderr).toContain(ABANDONED_KEY);
    expect(result.stderr).toContain(MEDIA_KEY);
    // The objects are still there: the command said so rather than reporting a
    // partial success.
    expect(await mediaStore.head(MEDIA_KEY)).not.toBeNull();
    expect(await contentStore.head(ABANDONED_KEY)).not.toBeNull();
  });

  it("counts a delete whose re-read itself fails as a failure", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedAbandonedUpload(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    // HEAD answers neither 404 nor "still there" — it errors. The old code
    // turned that into `deleted += 1`, printed "the object is gone" and exited
    // 0 while the object was still in the bucket. The fault is scoped to the
    // deleted keys so the command can still read `active.json`.
    const content = new FailingDeleteStorage(contentStore, {
      effectApplied: false,
      headBehaviour: (key) => (key === ABANDONED_KEY ? "throw" : "inner"),
    });
    const media = new FailingDeleteStorage(mediaStore, {
      effectApplied: false,
      headBehaviour: (key) => (key === MEDIA_KEY ? "throw" : "inner"),
    });
    const digest = await digestFor(contentStore, mediaStore);

    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(content, media),
    );

    expect(result.code).toBe(EXIT.REMOTE);
    expect(result.stdout).not.toContain("the object is gone");
    expect(result.stdout).toContain("could not be deleted");
    expect(result.stderr).toContain("could not be re-read to confirm");
    expect(await contentStore.head(ABANDONED_KEY)).not.toBeNull();
    expect(await mediaStore.head(MEDIA_KEY)).not.toBeNull();
  });

  it("deletes what a complete plan lists and reports the totals", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    const retained = seedRetainedRelease(contentStore);
    seedAbandonedUpload(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    const digest = await digestFor(contentStore, mediaStore);
    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(contentStore, mediaStore),
    );

    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("Deleted 2 object(s)");
    // The retained release is untouched.
    expect(await contentStore.head(manifestObjectKey(retained))).not.toBeNull();
    expect(await contentStore.head(ABANDONED_KEY)).toBeNull();
    expect(await mediaStore.head(MEDIA_KEY)).toBeNull();
  });

  it("does not delete while another release mutation holds the shared lease", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedAbandonedUpload(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });
    const digest = await digestFor(contentStore, mediaStore);
    const publisher = await acquireMutationLease({
      storage: contentStore,
      operation: "publish",
      owner: "publisher",
      now: () => NOW,
    });

    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(contentStore, mediaStore),
    );

    expect(result.code).toBe(EXIT.CONFLICT);
    expect(await contentStore.head(ABANDONED_KEY)).not.toBeNull();
    expect(await mediaStore.head(MEDIA_KEY)).not.toBeNull();
    await publisher.release();
  });
});

describe("content:cleanup with an incomplete plan", () => {
  /** A young release with an unparseable manifest, plus an old orphan object. */
  function seedBrokenRelease(content: MemoryStorage): void {
    withClock(content, NOW, () => {
      content.seed(BROKEN_MANIFEST_KEY, "{ not json\n");
      content.seed(`releases/${BROKEN_RELEASE}/content/posts/hello.md`, BODY);
    });
    seedAbandonedUpload(content);
  }

  it("refuses --apply and names the releases to repair", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedBrokenRelease(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    const digest = await digestFor(contentStore, mediaStore);
    const result = await run(
      ["--apply", "--plan", digest],
      portsFor(contentStore, mediaStore),
    );

    expect(result.code).toBe(EXIT.VALIDATION);
    expect(result.stderr).toContain("no readable manifest");
    expect(result.stderr).toContain("Repair manifest access first");
    expect(result.stderr).toContain(BROKEN_RELEASE);
    // Nothing was deleted, the old orphan object included.
    expect(await contentStore.head(ABANDONED_KEY)).not.toBeNull();
    expect(await mediaStore.head(MEDIA_KEY)).not.toBeNull();
  });

  it("still prints the dry-run plan, with the withheld deletions called out", async () => {
    const contentStore = new MemoryStorage("content");
    const mediaStore = new MemoryStorage("media");
    seedBrokenRelease(contentStore);
    withClock(mediaStore, OLD, () => {
      mediaStore.seed(MEDIA_KEY, "bytes");
    });

    const result = await run([], portsFor(contentStore, mediaStore));

    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("INCOMPLETE");
    expect(result.stdout).toContain("--apply will be refused");
    // The content deletion the plan did compute is still shown.
    expect(result.stdout).toContain(ABANDONED_KEY);
    expect(await contentStore.head(ABANDONED_KEY)).not.toBeNull();
  });
});
