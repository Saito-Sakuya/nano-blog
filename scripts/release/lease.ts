import { randomUUID } from "node:crypto";

import { z } from "astro/zod";

import { ConflictError, RemoteError, ValidationError } from "../lib/errors.js";
import { canonicalJson } from "./canonical-json.js";
import { PreconditionFailedError, type StorageAdapter } from "./storage.js";

/**
 * One cooperative mutex for every operation that can change release state.
 *
 * The record is never deleted. Acquisition and release are both conditional
 * overwrites, which means a process holding an old ETag can never release a
 * lease that another process has taken over after expiry.
 */
export const MUTATION_LEASE_KEY = "_control/mutation-lease.json";
export const MUTATION_LEASE_MAX_BYTES = 16 * 1024;
export const DEFAULT_MUTATION_LEASE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MUTATION_LEASE_RENEW_WINDOW_MS = 10 * 60 * 1_000;

export type MutationOperation =
  "publish" | "rollback" | "cleanup" | "deploy-only" | "media-add";

const heldLeaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.literal("held"),
  owner: z.string().min(1),
  operation: z.enum([
    "publish",
    "rollback",
    "cleanup",
    "deploy-only",
    "media-add",
  ]),
  acquiredAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

const releasedLeaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.literal("released"),
  owner: z.string().min(1),
  operation: z.enum([
    "publish",
    "rollback",
    "cleanup",
    "deploy-only",
    "media-add",
  ]),
  acquiredAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  releasedAt: z.iso.datetime({ offset: true }),
});

const mutationLeaseRecordSchema = z.discriminatedUnion("state", [
  heldLeaseSchema,
  releasedLeaseSchema,
]);

export type HeldMutationLeaseRecord = z.infer<typeof heldLeaseSchema>;
export type MutationLeaseRecord = z.infer<typeof mutationLeaseRecordSchema>;

function parseLeaseRecord(value: unknown): MutationLeaseRecord {
  const result = mutationLeaseRecordSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${MUTATION_LEASE_KEY} is not a valid lease.`, {
      issues: result.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
      ),
    });
  }
  return result.data;
}

function serializeLease(record: MutationLeaseRecord): Uint8Array {
  return Buffer.from(`${canonicalJson(record)}\n`, "utf8");
}

function requireEtag(etag: string | null, action: string): string {
  if (etag === null || etag.length === 0) {
    throw new RemoteError(
      `${MUTATION_LEASE_KEY} exists but the object store did not report an ETag, so it cannot be ${action} safely.`,
    );
  }
  return etag;
}

function expiresAt(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function isExpired(record: MutationLeaseRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

export interface AcquireMutationLeaseOptions {
  readonly storage: StorageAdapter;
  readonly operation: MutationOperation;
  readonly now?: () => Date;
  readonly owner?: string;
  readonly ttlMs?: number;
  readonly renewWindowMs?: number;
}

export class MutationLease {
  readonly #storage: StorageAdapter;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #renewWindowMs: number;
  #record: HeldMutationLeaseRecord;
  #etag: string;
  #released = false;

  constructor(options: {
    readonly storage: StorageAdapter;
    readonly now: () => Date;
    readonly ttlMs: number;
    readonly renewWindowMs: number;
    readonly record: HeldMutationLeaseRecord;
    readonly etag: string;
  }) {
    this.#storage = options.storage;
    this.#now = options.now;
    this.#ttlMs = options.ttlMs;
    this.#renewWindowMs = options.renewWindowMs;
    this.#record = options.record;
    this.#etag = options.etag;
  }

  get owner(): string {
    return this.#record.owner;
  }

  get operation(): MutationOperation {
    return this.#record.operation;
  }

  get record(): HeldMutationLeaseRecord {
    return this.#record;
  }

  async renew(): Promise<void> {
    if (this.#released) {
      throw new ConflictError("The mutation lease has already been released.");
    }

    const now = this.#now();
    const next: HeldMutationLeaseRecord = {
      ...this.#record,
      updatedAt: now.toISOString(),
      expiresAt: expiresAt(now, this.#ttlMs),
    };

    try {
      const result = await this.#storage.put(
        MUTATION_LEASE_KEY,
        serializeLease(next),
        {
          contentType: "application/json; charset=utf-8",
          cacheControl: "no-store",
          ifMatch: this.#etag,
        },
      );
      this.#etag = requireEtag(result.etag, "renewed");
      this.#record = next;
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new ConflictError(
          `The ${this.operation} lease changed while the operation was running. Refusing to continue with a lease that is no longer owned by this process.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async renewIfNeeded(): Promise<void> {
    const remaining =
      Date.parse(this.#record.expiresAt) - this.#now().getTime();
    if (remaining <= this.#renewWindowMs) await this.renew();
  }

  async release(): Promise<void> {
    if (this.#released) return;

    const now = this.#now();
    const released: MutationLeaseRecord = {
      ...this.#record,
      state: "released",
      updatedAt: now.toISOString(),
      releasedAt: now.toISOString(),
    };

    try {
      await this.#storage.put(MUTATION_LEASE_KEY, serializeLease(released), {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
        ifMatch: this.#etag,
      });
      this.#released = true;
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new ConflictError(
          `The ${this.operation} lease changed before it could be released. It was not overwritten.`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export async function acquireMutationLease(
  options: AcquireMutationLeaseOptions,
): Promise<MutationLease> {
  const now = options.now ?? (() => new Date());
  const instant = now();
  const ttlMs = options.ttlMs ?? DEFAULT_MUTATION_LEASE_TTL_MS;
  const renewWindowMs =
    options.renewWindowMs ?? DEFAULT_MUTATION_LEASE_RENEW_WINDOW_MS;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("The mutation lease TTL must be a positive number.");
  }
  if (
    !Number.isFinite(renewWindowMs) ||
    renewWindowMs < 0 ||
    renewWindowMs >= ttlMs
  ) {
    throw new RangeError(
      "The mutation lease renewal window must be non-negative and shorter than its TTL.",
    );
  }

  const owner = options.owner ?? randomUUID();
  const record: HeldMutationLeaseRecord = {
    schemaVersion: 1,
    state: "held",
    owner,
    operation: options.operation,
    acquiredAt: instant.toISOString(),
    updatedAt: instant.toISOString(),
    expiresAt: expiresAt(instant, ttlMs),
  };

  const head = await options.storage.head(MUTATION_LEASE_KEY);
  let ifMatch: string | undefined;
  let ifNoneMatch = false;

  if (head === null) {
    ifNoneMatch = true;
  } else {
    const data = await options.storage.get(MUTATION_LEASE_KEY, {
      maxBytes: MUTATION_LEASE_MAX_BYTES,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(data.bytes).toString("utf8"));
    } catch (error) {
      throw new ValidationError(`${MUTATION_LEASE_KEY} is not valid JSON.`, {
        cause: error,
      });
    }
    const current = parseLeaseRecord(parsed);
    if (current.state === "held" && !isExpired(current, instant)) {
      throw new ConflictError(
        `A ${current.operation} operation already holds the mutation lease until ${current.expiresAt}. Wait for it to finish before starting ${options.operation}.`,
      );
    }
    ifMatch = requireEtag(data.head.etag ?? head.etag, "acquired");
  }

  try {
    const result = await options.storage.put(
      MUTATION_LEASE_KEY,
      serializeLease(record),
      {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
        ...(ifMatch === undefined ? {} : { ifMatch }),
        ...(ifNoneMatch ? { ifNoneMatch: true } : {}),
      },
    );
    return new MutationLease({
      storage: options.storage,
      now,
      ttlMs,
      renewWindowMs,
      record,
      etag: requireEtag(result.etag, "held"),
    });
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      throw new ConflictError(
        `Another release operation acquired ${MUTATION_LEASE_KEY} at the same time. Nothing was changed by this operation.`,
        { cause: error },
      );
    }
    throw error;
  }
}
