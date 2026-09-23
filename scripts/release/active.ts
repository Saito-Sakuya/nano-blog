import { z } from "astro/zod";

import { ConflictError, RemoteError, ValidationError } from "../lib/errors.js";
import { attemptOnce } from "../lib/retry.js";
import { canonicalJson } from "./canonical-json.js";
import { isContentDigest, isReleaseId } from "./digest.js";
import { manifestObjectKey } from "./manifest.js";
import { PreconditionFailedError, type StorageAdapter } from "./storage.js";

/**
 * The `active.json` pointer.
 *
 * This is the only mutable object in the content bucket, and the only thing
 * that decides which release the site builds from. It is therefore the object
 * where a concurrency bug would be worst: two publishers writing it
 * unconditionally would silently abandon one of the two releases.
 *
 * The rule is compare-and-swap, enforced by the object store itself:
 *
 * - no pointer yet → `If-None-Match: *`
 * - a pointer exists → `If-Match: <the exact ETag read at the start>`
 *
 * There is no unconditional write anywhere in this module. If the store cannot
 * supply an ETag for an existing pointer, the write is refused rather than
 * downgraded — a publisher that cannot detect a concurrent change must not
 * publish.
 */

export const ACTIVE_KEY = "active.json";
export const ACTIVE_CONTENT_TYPE = "application/json; charset=utf-8";
/** Never cached: a stale read must not be able to decide a publish. */
export const ACTIVE_CACHE_CONTROL = "no-store";
/** `active.json` is a few hundred bytes; anything larger is not this file. */
export const ACTIVE_MAX_BYTES = 64 * 1024;

export interface ActivePointer {
  readonly schemaVersion: number;
  readonly releaseId: string;
  readonly manifestKey: string;
  readonly contentDigest: string;
  readonly activatedAt: string;
}

export const activePointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseId: z
    .string()
    .refine(isReleaseId, "Must be YYYYMMDDTHHmmssZ-<12 hex>."),
  manifestKey: z.string(),
  contentDigest: z
    .string()
    .refine(isContentDigest, "Must be sha256:<64 lowercase hex>."),
  activatedAt: z.iso.datetime({ offset: true }),
});

export function buildActivePointer(input: {
  readonly releaseId: string;
  readonly contentDigest: string;
  readonly instant: Date;
}): ActivePointer {
  return {
    schemaVersion: 1,
    releaseId: input.releaseId,
    manifestKey: manifestObjectKey(input.releaseId),
    contentDigest: input.contentDigest,
    activatedAt: input.instant.toISOString(),
  };
}

export function parseActivePointer(
  value: unknown,
  label = ACTIVE_KEY,
): ActivePointer {
  const result = activePointerSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${label} is not a valid active pointer.`, {
      issues: result.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
      ),
    });
  }

  const pointer = result.data;
  const expectedKey = manifestObjectKey(pointer.releaseId);
  if (pointer.manifestKey !== expectedKey) {
    throw new ValidationError(
      `${label} points at ${pointer.manifestKey}, but its release id requires ${expectedKey}.`,
    );
  }

  return pointer;
}

/** Canonical JSON, so the same pointer hashes to the same bytes. */
export function serializeActivePointer(pointer: ActivePointer): Uint8Array {
  return Buffer.from(`${canonicalJson(pointer)}\n`, "utf8");
}

export interface ActiveState {
  readonly pointer: ActivePointer | null;
  /** The ETag read with the pointer; required for a compare-and-swap. */
  readonly etag: string | null;
}

export const EMPTY_ACTIVE_STATE: ActiveState = { pointer: null, etag: null };

/**
 * Read the current pointer and the ETag that came with it.
 *
 * The ETag is captured here and nowhere else: every later write must carry the
 * value this call saw, which is what makes a concurrent publish detectable.
 */
export async function readActive(
  storage: StorageAdapter,
): Promise<ActiveState> {
  const head = await storage.head(ACTIVE_KEY);
  if (head === null) return EMPTY_ACTIVE_STATE;

  const data = await storage.get(ACTIVE_KEY, { maxBytes: ACTIVE_MAX_BYTES });

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(data.bytes).toString("utf8"));
  } catch (error) {
    throw new ValidationError(
      `${ACTIVE_KEY} is not valid JSON: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }

  return {
    pointer: parseActivePointer(parsed),
    etag: data.head.etag ?? head.etag,
  };
}

export interface ActivationRequest {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: boolean;
}

/**
 * Decide the conditional request that would activate `next`.
 *
 * Fails rather than degrades: an existing pointer with no ETag means the
 * compare-and-swap cannot be expressed, so nothing is written.
 */
export function planActivation(
  state: ActiveState,
  next: ActivePointer,
): ActivationRequest {
  const body = serializeActivePointer(next);

  if (state.pointer === null) {
    return {
      key: ACTIVE_KEY,
      body,
      contentType: ACTIVE_CONTENT_TYPE,
      cacheControl: ACTIVE_CACHE_CONTROL,
      ifNoneMatch: true,
    };
  }

  if (state.etag === null || state.etag.length === 0) {
    throw new RemoteError(
      `${ACTIVE_KEY} exists but the object store did not report an ETag, so the required compare-and-swap cannot be expressed. Refusing to write the pointer unconditionally.`,
    );
  }

  return {
    key: ACTIVE_KEY,
    body,
    contentType: ACTIVE_CONTENT_TYPE,
    cacheControl: ACTIVE_CACHE_CONTROL,
    ifMatch: state.etag,
  };
}

export interface ActivationResult {
  readonly pointer: ActivePointer;
  readonly etag: string | null;
  /** True when the pointer already named this release and nothing was written. */
  readonly unchanged: boolean;
}

export function sameActivation(
  a: ActivePointer | null,
  b: ActivePointer,
): boolean {
  return (
    a !== null &&
    a.releaseId === b.releaseId &&
    a.contentDigest === b.contentDigest
  );
}

/**
 * Move the pointer, or report that it already points where it should.
 *
 * The write is sent exactly once. A lost precondition is reported as a
 * conflict (exit code 6) for the caller to re-read and re-verify; it is never
 * retried with the same stale ETag.
 */
export async function applyActivation(
  storage: StorageAdapter,
  state: ActiveState,
  next: ActivePointer,
): Promise<ActivationResult> {
  if (sameActivation(state.pointer, next)) {
    return { pointer: next, etag: state.etag, unchanged: true };
  }

  const request = planActivation(state, next);

  try {
    const result = await attemptOnce(() =>
      storage.put(request.key, request.body, {
        contentType: request.contentType,
        cacheControl: request.cacheControl,
        ...(request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }),
        ...(request.ifNoneMatch === true ? { ifNoneMatch: true } : {}),
      }),
    );

    return { pointer: next, etag: result.etag, unchanged: false };
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      throw new ConflictError(
        `${ACTIVE_KEY} changed while this command was running (${error.reason === "exists" ? "another publisher created it" : "another publisher moved it"}). Nothing was written. Re-read the pointer and publish again.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** True when the pointer names exactly this release and digest. */
export function pointsAt(
  pointer: ActivePointer | null,
  releaseId: string,
): boolean {
  return pointer !== null && pointer.releaseId === releaseId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
