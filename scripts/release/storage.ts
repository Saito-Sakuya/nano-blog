import { ConflictError, RemoteError } from "../lib/errors.js";
import { sha256Hex } from "./digest.js";

/**
 * The storage adapter.
 *
 * Everything that talks to R2 goes through this interface, and nothing else in
 * the tooling knows whether the bytes behind it live in a bucket, in a `Map`, or
 * in a recorder that refuses to write. That is what makes it possible to assert
 * the central safety property of this project — a command without `--apply`
 * performs zero puts, zero deletes and zero deploy-hook calls — without a
 * network, and to unit-test pagination, conditional writes and idempotent reuse
 * directly.
 *
 * Three implementations ship:
 *
 * - `S3Storage` — the real one, over the S3-compatible R2 API.
 * - `MemoryStorage` — an in-process bucket used by tests and by planning.
 * - `DryRunStorage` — delegates every read, records every intended write, and
 *   forwards nothing. The adapter underneath it observes no mutation at all.
 */

export interface ObjectSummary {
  readonly key: string;
  readonly bytes: number;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

export interface ObjectHead {
  readonly key: string;
  readonly bytes: number;
  readonly etag: string | null;
  readonly contentType: string | null;
}

export interface ObjectData {
  readonly head: ObjectHead;
  readonly bytes: Uint8Array;
}

export interface PutOptions {
  readonly contentType: string;
  readonly cacheControl?: string;
  /**
   * `true` means `If-None-Match: *`: create only if the key does not exist.
   * Immutable release and media objects are always written this way.
   */
  readonly ifNoneMatch?: boolean;
  /** `If-Match: <etag>`: the compare-and-swap used for `active.json`. */
  readonly ifMatch?: string;
}

export interface PutResult {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  /** False when the identical object was already there (idempotent skip). */
  readonly created: boolean;
  readonly etag: string | null;
}

export interface MutationCounter {
  puts: number;
  deletes: number;
  conditionalPuts: number;
}

export function createMutationCounter(): MutationCounter {
  return { puts: 0, deletes: 0, conditionalPuts: 0 };
}

export interface StorageAdapter {
  /** Shown in output; never contains a credential. */
  readonly label: string;
  /** Mutating calls this adapter actually performed. */
  readonly mutations: MutationCounter;
  /** Every object whose key starts with `prefix`, one page at a time internally. */
  list(prefix: string): AsyncIterable<ObjectSummary>;
  head(key: string): Promise<ObjectHead | null>;
  get(
    key: string,
    options?: { readonly maxBytes?: number },
  ): Promise<ObjectData>;
  put(key: string, body: Uint8Array, options: PutOptions): Promise<PutResult>;
  delete(key: string): Promise<void>;
}

/**
 * A conditional request lost the race.
 *
 * For an immutable object this is not an error by itself — the caller re-reads
 * the key and compares digests, and an identical object is a successful
 * idempotent skip. For `active.json` it means somebody else published.
 */
export class PreconditionFailedError extends ConflictError {
  readonly reason: "exists" | "etag-mismatch";

  constructor(key: string, reason: "exists" | "etag-mismatch") {
    super(
      reason === "exists"
        ? `${key} already exists and the write required If-None-Match: *.`
        : `${key} changed since it was read; the write required If-Match with the etag that was read.`,
    );
    this.name = "PreconditionFailedError";
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory bucket                                                            */
/* -------------------------------------------------------------------------- */

interface MemoryObject {
  bytes: Uint8Array;
  contentType: string;
  cacheControl: string | undefined;
  etag: string;
  lastModified: Date;
  sha256: string;
}

function etagFor(sha256: string): string {
  return `"${sha256.slice(0, 32)}"`;
}

function matchesPrefix(key: string, prefix: string): boolean {
  return key.startsWith(prefix);
}

/**
 * An in-process bucket with the same conditional semantics as R2.
 *
 * Used by tests and as the planning overlay for dry runs, so that intent and
 * effect are described by the same code path.
 */
export class MemoryStorage implements StorageAdapter {
  readonly label: string;
  readonly mutations: MutationCounter = createMutationCounter();
  readonly #objects = new Map<string, MemoryObject>();
  #clock: () => Date;

  constructor(label = "memory", clock: () => Date = () => new Date()) {
    this.label = label;
    this.#clock = clock;
  }

  /** Test helper: put an object without going through the adapter contract. */
  seed(
    key: string,
    body: Uint8Array | string,
    options: {
      readonly contentType?: string;
      readonly cacheControl?: string;
    } = {},
  ): void {
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const sha256 = sha256Hex(bytes);
    this.#objects.set(key, {
      bytes,
      contentType: options.contentType ?? "application/octet-stream",
      cacheControl: options.cacheControl,
      etag: etagFor(sha256),
      lastModified: this.#clock(),
      sha256,
    });
  }

  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  snapshot(): ObjectSummary[] {
    return [...this.#objects.entries()]
      .map(([key, object]) => ({
        key,
        bytes: object.bytes.byteLength,
        etag: object.etag,
        lastModified: object.lastModified,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  setClock(clock: () => Date): void {
    this.#clock = clock;
  }

  async *list(prefix: string): AsyncIterable<ObjectSummary> {
    for (const summary of this.snapshot()) {
      if (matchesPrefix(summary.key, prefix)) yield summary;
    }
  }

  head(key: string): Promise<ObjectHead | null> {
    const object = this.#objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({
      key,
      bytes: object.bytes.byteLength,
      etag: object.etag,
      contentType: object.contentType,
    });
  }

  get(key: string, options: { maxBytes?: number } = {}): Promise<ObjectData> {
    const object = this.#objects.get(key);
    if (object === undefined) {
      return Promise.reject(
        new RemoteError(`${this.label}: ${key} does not exist.`),
      );
    }
    if (
      options.maxBytes !== undefined &&
      object.bytes.byteLength > options.maxBytes
    ) {
      return Promise.reject(
        new RemoteError(
          `${this.label}: ${key} is ${object.bytes.byteLength} bytes, above the ${options.maxBytes}-byte limit.`,
        ),
      );
    }
    return Promise.resolve({
      head: {
        key,
        bytes: object.bytes.byteLength,
        etag: object.etag,
        contentType: object.contentType,
      },
      bytes: object.bytes,
    });
  }

  put(key: string, body: Uint8Array, options: PutOptions): Promise<PutResult> {
    const existing = this.#objects.get(key);
    const sha256 = sha256Hex(body);

    if (options.ifNoneMatch === true && existing !== undefined) {
      this.mutations.conditionalPuts += 1;
      return Promise.reject(new PreconditionFailedError(key, "exists"));
    }
    if (
      options.ifMatch !== undefined &&
      (existing === undefined || existing.etag !== options.ifMatch)
    ) {
      this.mutations.conditionalPuts += 1;
      return Promise.reject(new PreconditionFailedError(key, "etag-mismatch"));
    }

    if (existing !== undefined && existing.sha256 === sha256) {
      // The object is already exactly what would be written; nothing is sent.
      return Promise.resolve({
        key,
        bytes: body.byteLength,
        sha256,
        created: false,
        etag: existing.etag,
      });
    }

    this.mutations.puts += 1;
    if (options.ifNoneMatch === true || options.ifMatch !== undefined) {
      this.mutations.conditionalPuts += 1;
    }

    const stored: MemoryObject = {
      bytes: Uint8Array.from(body),
      contentType: options.contentType,
      cacheControl: options.cacheControl,
      etag: etagFor(sha256),
      lastModified: this.#clock(),
      sha256,
    };
    this.#objects.set(key, stored);

    return Promise.resolve({
      key,
      bytes: body.byteLength,
      sha256,
      created: true,
      etag: stored.etag,
    });
  }

  delete(key: string): Promise<void> {
    this.mutations.deletes += 1;
    this.#objects.delete(key);
    return Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* Dry-run overlay                                                             */
/* -------------------------------------------------------------------------- */

export interface PlannedPut {
  readonly key: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly cacheControl?: string;
  /** False when the object is already present with the same content. */
  readonly created: boolean;
}

/**
 * A read-through, write-recording adapter.
 *
 * Reads reach the real bucket so that a plan describes the actual remote state.
 * Writes are recorded and answered as if they had happened, and are never
 * forwarded. The wrapped adapter's mutation counter therefore stays at zero,
 * which a test can assert directly.
 */
export class DryRunStorage implements StorageAdapter {
  readonly label: string;
  readonly plan: {
    readonly puts: PlannedPut[];
    readonly deletes: string[];
  } = { puts: [], deletes: [] };

  /** Always zero: a dry run mutates nothing, by construction. */
  readonly mutations: MutationCounter = createMutationCounter();
  readonly #inner: StorageAdapter;
  readonly #known = new Map<
    string,
    { bytes: number; sha256: string | null; etag: string | null }
  >();

  constructor(inner: StorageAdapter) {
    this.#inner = inner;
    this.label = `${inner.label} (dry run)`;
  }

  async *list(prefix: string): AsyncIterable<ObjectSummary> {
    yield* this.#inner.list(prefix);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const known = this.#known.get(key);
    if (known !== undefined) {
      return { key, bytes: known.bytes, etag: known.etag, contentType: null };
    }
    return this.#inner.head(key);
  }

  get(key: string, options: { maxBytes?: number } = {}): Promise<ObjectData> {
    return this.#inner.get(key, options);
  }

  put(key: string, body: Uint8Array, options: PutOptions): Promise<PutResult> {
    const sha256 = sha256Hex(body);
    const known = this.#known.get(key) ?? null;

    if (
      options.ifMatch !== undefined &&
      (known === null || known.etag !== options.ifMatch)
    ) {
      return Promise.reject(new PreconditionFailedError(key, "etag-mismatch"));
    }
    if (options.ifNoneMatch === true && known !== null) {
      return Promise.reject(new PreconditionFailedError(key, "exists"));
    }

    const created = known === null || known.sha256 !== sha256;
    if (created) {
      this.plan.puts.push({
        key,
        bytes: body.byteLength,
        contentType: options.contentType,
        ...(options.cacheControl === undefined
          ? {}
          : { cacheControl: options.cacheControl }),
        created,
      });
    }

    this.#known.set(key, {
      bytes: body.byteLength,
      sha256,
      etag: etagFor(sha256),
    });
    return Promise.resolve({
      key,
      bytes: body.byteLength,
      sha256,
      created,
      etag: etagFor(sha256),
    });
  }

  delete(key: string): Promise<void> {
    this.plan.deletes.push(key);
    this.#known.delete(key);
    return Promise.resolve();
  }
}

export function isDryRunStorage(
  adapter: StorageAdapter,
): adapter is DryRunStorage {
  return adapter instanceof DryRunStorage;
}
