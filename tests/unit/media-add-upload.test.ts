import { describe, expect, it } from "vitest";

import {
  ConflictError,
  RemoteError,
  ValidationError,
} from "../../scripts/lib/errors";
import { messageOf } from "../../scripts/lib/fs-util";
import { uploadPlan, uploadPlanWhenApplied } from "../../scripts/media/add";
import {
  planMedia,
  type MediaPlan,
  type MediaPlanEntry,
} from "../../scripts/media/plan";
import type { ImageProcessor } from "../../scripts/media/processor";
import { acquireMutationLease } from "../../scripts/release/lease";
import {
  createFixedPortsFactory,
  createMemoryPorts,
  type PortsFactory,
} from "../../scripts/release/ports";
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
 * `media:add --apply` uploads two kinds of object with two different rules, and
 * the old code applied the immutable rule to both: `meta.json` was written with
 * `If-None-Match: *` while its own cache policy says `must-revalidate`, so a
 * second run with a corrected `--alt` could never succeed. These tests pin the
 * two rules apart, and pin the error message to the object it is about.
 */

const NOW = new Date("2026-09-15T00:00:00.000Z");
const ALT = "A blue gradient used in the upload tests";

/** Enough of a PNG for the signature check; the pipeline is faked below. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const images: ImageProcessor = {
  label: "test image pipeline",
  sanitize: async (bytes) => bytes,
  metadata: async () => ({
    width: 1600,
    height: 900,
    format: "png",
    hasAlpha: false,
  }),
  stats: async () => ({ stdev: [11, 11, 11], uniqueColours: 512, entropy: 7 }),
  derive: async (_bytes, options) => ({
    width: options.width,
    height: options.crop ? Math.round((options.width * 9) / 16) : options.width,
    format: options.format,
    bytes: Buffer.from(`derived-${options.width}-${options.format}`),
  }),
};

async function plan(credit?: string): Promise<MediaPlan> {
  return planMedia({
    filePath: "test-image.png",
    alt: ALT,
    cover: false,
    images,
    now: NOW,
    mediaOrigin: "https://media.example.test",
    bytes: PNG,
    ...(credit === undefined ? {} : { credit }),
  });
}

function metaEntryOf(value: MediaPlan): MediaPlanEntry {
  const entry = value.entries.find((candidate) => candidate.role === "meta");
  if (entry === undefined) throw new Error("the plan has no meta.json entry");
  return entry;
}

function variantEntryOf(value: MediaPlan): MediaPlanEntry {
  const entry = value.entries.find((candidate) => candidate.role === "variant");
  if (entry === undefined) throw new Error("the plan has no variant entry");
  return entry;
}

function payloadOf(value: MediaPlan, entry: MediaPlanEntry): Uint8Array {
  const payload = value.payloads.get(entry.key);
  if (payload === undefined) {
    throw new Error(`the plan has no payload for ${entry.key}`);
  }
  return payload;
}

/** The outcome of a promise, as a value, without asserting anything yet. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

/**
 * A bucket where somebody else rewrites `meta.json` between the HEAD that reads
 * its ETag and the PUT that uses it.
 */
class RacingMetaStorage implements StorageAdapter {
  readonly inner: MemoryStorage;
  readonly #watched: string;
  #raced = false;

  constructor(inner: MemoryStorage, watched: string) {
    this.inner = inner;
    this.#watched = watched;
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
    return this.inner.head(key);
  }

  get(key: string, options: { maxBytes?: number } = {}): Promise<ObjectData> {
    return this.inner.get(key, options);
  }

  async put(
    key: string,
    body: Uint8Array,
    options: PutOptions,
  ): Promise<PutResult> {
    if (!this.#raced && key === this.#watched) {
      this.#raced = true;
      await this.inner.put(key, Buffer.from("somebody else's metadata\n"), {
        contentType: "application/json; charset=utf-8",
      });
    }
    return this.inner.put(key, body, options);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

describe("uploadPlan", () => {
  it("checks the mutation lease before each remote object", async () => {
    const storage = new MemoryStorage("media");
    const value = await plan();
    let checked = 0;

    await uploadPlan(value, storage, async () => {
      checked += 1;
    });

    expect(checked).toBe(value.entries.length);
  });

  it("stops uploading when the lease check fails", async () => {
    const storage = new MemoryStorage("media");
    const value = await plan();

    await expect(
      uploadPlan(value, storage, async () => {
        throw new ConflictError("lease was lost");
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(storage.keys()).toEqual([]);
  });

  it("uploads every object once and reuses all of them on a second run", async () => {
    const storage = new MemoryStorage("media");
    const value = await plan();

    const first = await uploadPlan(value, storage);
    expect(first.uploaded).toBe(value.entries.length);
    expect(first.reused).toBe(0);
    expect(first.bytes).toBe(value.totalBytes);

    const second = await uploadPlan(await plan(), storage);
    expect(second.uploaded).toBe(0);
    expect(second.reused).toBe(value.entries.length);
  });

  it("rewrites meta.json when the credit changes", async () => {
    const storage = new MemoryStorage("media");
    await uploadPlan(await plan("Photo: A. Example"), storage);

    const corrected = await plan("Photo: B. Example");
    const summary = await uploadPlan(corrected, storage);

    // Only the metadata is rewritten; the derived objects are already exactly
    // what the plan holds.
    expect(summary.uploaded).toBe(1);
    expect(summary.reused).toBe(corrected.entries.length - 1);

    const meta = metaEntryOf(corrected);
    const stored = await storage.get(meta.key);
    const text = Buffer.from(stored.bytes).toString("utf8");
    expect(text).toBe(Buffer.from(payloadOf(corrected, meta)).toString("utf8"));
    expect(text).toContain("Photo: B. Example");
  });

  it("refuses to overwrite an immutable derivative that holds other bytes", async () => {
    const storage = new MemoryStorage("media");
    const value = await plan();
    await uploadPlan(value, storage);

    const variant = variantEntryOf(value);
    storage.seed(variant.key, Buffer.from("bytes this key never named"));

    const failure = await outcomeOf(uploadPlan(value, storage));
    expect(failure).toBeInstanceOf(ValidationError);
    expect(messageOf(failure)).toContain(variant.key);
    expect(messageOf(failure)).toContain("immutable");
    expect(messageOf(failure)).toContain("only meta.json may be rewritten");

    // The object it refused to overwrite is untouched.
    const stored = await storage.get(variant.key);
    expect(Buffer.from(stored.bytes).toString("utf8")).toBe(
      "bytes this key never named",
    );
  });

  it("refuses to rewrite meta.json that changed since it was read", async () => {
    const inner = new MemoryStorage("media");
    await uploadPlan(await plan("Photo: A. Example"), inner);

    const corrected = await plan("Photo: C. Example");
    const racing = new RacingMetaStorage(inner, metaEntryOf(corrected).key);

    const failure = await outcomeOf(uploadPlan(corrected, racing));
    expect(failure).toBeInstanceOf(RemoteError);
    expect(messageOf(failure)).toContain(
      "changed while this run was writing it",
    );
  });
});

describe("media:add mutation lease", () => {
  it("does not create remote ports or acquire a lease in dry-run mode", async () => {
    let createCalls = 0;
    const ports: PortsFactory = {
      create: () => {
        createCalls += 1;
        throw new Error("dry-run must not request remote ports");
      },
    };

    await expect(
      uploadPlanWhenApplied({
        apply: false,
        plan: await plan(),
        ports,
        now: () => NOW,
      }),
    ).resolves.toBeNull();
    expect(createCalls).toBe(0);
  });

  it("does not upload while publish holds the shared content-bucket lease", async () => {
    const ports = createMemoryPorts({ dryRun: false });
    const publisher = await acquireMutationLease({
      storage: ports.contentStore,
      operation: "publish",
      owner: "publisher",
      now: () => NOW,
    });

    try {
      await expect(
        uploadPlanWhenApplied({
          apply: true,
          plan: await plan(),
          ports: createFixedPortsFactory(ports),
          now: () => NOW,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(ports.mediaStore.keys()).toEqual([]);
    } finally {
      await publisher.release();
    }
  });

  it("releases the lease after a successful media upload", async () => {
    const ports = createMemoryPorts({ dryRun: false });
    const value = await plan();

    await expect(
      uploadPlanWhenApplied({
        apply: true,
        plan: value,
        ports: createFixedPortsFactory(ports),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ uploaded: value.entries.length, reused: 0 });

    const next = await acquireMutationLease({
      storage: ports.contentStore,
      operation: "rollback",
      owner: "rollback",
      now: () => NOW,
    });
    await next.release();
  });

  it("releases the lease when an upload fails", async () => {
    const ports = createMemoryPorts({ dryRun: false });
    const value = await plan();
    const variant = variantEntryOf(value);
    ports.mediaStore.seed(variant.key, "wrong bytes");

    await expect(
      uploadPlanWhenApplied({
        apply: true,
        plan: value,
        ports: createFixedPortsFactory(ports),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const next = await acquireMutationLease({
      storage: ports.contentStore,
      operation: "cleanup",
      owner: "cleanup",
      now: () => NOW,
    });
    await next.release();
  });
});
