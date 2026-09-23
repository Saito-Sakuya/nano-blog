import { RemoteError } from "../lib/errors.js";
import {
  attemptOnce,
  DEFAULT_RETRY_POLICY,
  withRetry,
  type RetryDependencies,
  type RetryPolicy,
} from "../lib/retry.js";
import { sha256Hex } from "./digest.js";
import {
  PreconditionFailedError,
  createMutationCounter,
  type MutationCounter,
  type ObjectData,
  type ObjectHead,
  type ObjectSummary,
  type PutOptions,
  type PutResult,
  type StorageAdapter,
} from "./storage.js";
import {
  isMissingObjectError,
  nameOfSdkError,
  statusOfSdkError,
  type S3Operations,
} from "./s3-operations.js";

/**
 * The S3-compatible R2 adapter.
 *
 * Three behaviours live here and nowhere else:
 *
 * 1. **Listing paginates.** `ListObjectsV2` returns at most 1000 keys and sets
 *    `IsTruncated`; a loop that reads only the first page would silently ignore
 *    every later release, which is how a cleanup command deletes the wrong
 *    things.
 * 2. **Reads and immutable writes retry** on 429/5xx with jittered exponential
 *    backoff; the conditional `active.json` write and deletes do not retry at
 *    all, because repeating them would act on state the caller never read.
 * 3. **Failures come back as `RemoteError`** (exit code 5), except a lost
 *    conditional write, which is a `PreconditionFailedError` (exit code 6 when
 *    it concerns `active.json`).
 */

export interface S3StorageOptions {
  readonly bucket: string;
  readonly operations: S3Operations;
  readonly label?: string;
  readonly policy?: Partial<RetryPolicy>;
  readonly retryDependencies?: RetryDependencies;
  readonly pageSize?: number;
}

export class S3Storage implements StorageAdapter {
  readonly label: string;
  readonly mutations: MutationCounter = createMutationCounter();
  readonly #bucket: string;
  readonly #operations: S3Operations;
  readonly #policy: Partial<RetryPolicy>;
  readonly #dependencies: RetryDependencies | undefined;
  readonly #pageSize: number | undefined;

  constructor(options: S3StorageOptions) {
    this.#bucket = options.bucket;
    this.#operations = options.operations;
    this.#policy = options.policy ?? {};
    this.#dependencies = options.retryDependencies;
    this.#pageSize = options.pageSize;
    this.label =
      options.label ?? `${options.operations.label}:${options.bucket}`;
  }

  #retryOptions(): {
    policy: Partial<RetryPolicy>;
    dependencies?: RetryDependencies;
  } {
    return this.#dependencies === undefined
      ? { policy: this.#policy }
      : { policy: this.#policy, dependencies: this.#dependencies };
  }

  async *list(prefix: string): AsyncIterable<ObjectSummary> {
    let continuationToken: string | undefined;
    let pageNumber = 0;

    do {
      pageNumber += 1;
      const token = continuationToken;
      const page = await withRetry(
        () =>
          this.#operations.listObjects({
            bucket: this.#bucket,
            prefix,
            ...(token === undefined ? {} : { continuationToken: token }),
            ...(this.#pageSize === undefined
              ? {}
              : { maxKeys: this.#pageSize }),
          }),
        this.#retryOptions(),
      ).catch((error: unknown) => {
        throw new RemoteError(
          `Could not list ${this.#bucket} with prefix ${JSON.stringify(prefix)} (page ${pageNumber}): ${describe(error)}`,
          { cause: error },
        );
      });

      for (const object of page.objects) {
        // A page is only trusted for the prefix that was requested; an object
        // outside it would otherwise be able to widen the caller's scope.
        if (!object.key.startsWith(prefix)) continue;
        yield {
          key: object.key,
          bytes: object.bytes,
          etag: object.etag,
          lastModified: object.lastModified,
        };
      }

      if (!page.truncated) {
        continuationToken = undefined;
        continue;
      }

      if (
        page.nextContinuationToken === null ||
        page.nextContinuationToken.length === 0
      ) {
        throw new RemoteError(
          `Listing ${this.#bucket} reported IsTruncated without a continuation token; refusing to treat a partial listing as complete.`,
        );
      }
      continuationToken = page.nextContinuationToken;
    } while (continuationToken !== undefined);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const head = await withRetry(
        () => this.#operations.headObject({ bucket: this.#bucket, key }),
        this.#retryOptions(),
      );
      if (head === null) return null;
      return {
        key,
        bytes: head.bytes,
        etag: head.etag,
        contentType: head.contentType,
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw new RemoteError(
        `Could not read the metadata of ${key}: ${describe(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  async get(
    key: string,
    options: { maxBytes?: number } = {},
  ): Promise<ObjectData> {
    let body;
    try {
      body = await withRetry(
        () =>
          this.#operations.getObject({
            bucket: this.#bucket,
            key,
            ...(options.maxBytes === undefined
              ? {}
              : { maxBytes: options.maxBytes }),
          }),
        this.#retryOptions(),
      );
    } catch (error) {
      throw new RemoteError(`Could not download ${key}: ${describe(error)}`, {
        cause: error,
      });
    }

    if (body === null) {
      throw new RemoteError(`${key} does not exist in ${this.#bucket}.`);
    }

    return {
      head: {
        key,
        bytes: body.bytes.byteLength,
        etag: body.etag,
        contentType: body.contentType,
      },
      bytes: body.bytes,
    };
  }

  async put(
    key: string,
    body: Uint8Array,
    options: PutOptions,
  ): Promise<PutResult> {
    const sha256 = sha256Hex(body);
    const request = {
      bucket: this.#bucket,
      key,
      body,
      contentType: options.contentType,
      ...(options.cacheControl === undefined
        ? {}
        : { cacheControl: options.cacheControl }),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.ifNoneMatch === true ? { ifNoneMatch: true } : {}),
    };

    const conditional =
      options.ifMatch !== undefined || options.ifNoneMatch === true;

    try {
      // An immutable create is safe to repeat: if the first attempt actually
      // landed, the retry sees a precondition failure and the caller compares
      // digests. A compare-and-swap is not, and is sent exactly once.
      const result =
        options.ifMatch === undefined
          ? await withRetry(
              () => this.#operations.putObject(request),
              this.#retryOptions(),
            )
          : await attemptOnce(() => this.#operations.putObject(request));

      this.mutations.puts += 1;
      if (conditional) this.mutations.conditionalPuts += 1;
      return {
        key,
        bytes: body.byteLength,
        sha256,
        created: true,
        etag: result.etag,
      };
    } catch (error) {
      const status = statusOfSdkError(error);
      const name = nameOfSdkError(error);
      if (status === 412 || name === "PreconditionFailed") {
        if (conditional) this.mutations.conditionalPuts += 1;
        throw new PreconditionFailedError(
          key,
          options.ifMatch === undefined ? "exists" : "etag-mismatch",
        );
      }
      if (status === 409 || name === "ConditionalRequestConflict") {
        if (conditional) this.mutations.conditionalPuts += 1;
        throw new PreconditionFailedError(key, "etag-mismatch");
      }
      throw new RemoteError(`Could not upload ${key}: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      // Sent once. A delete that appears to fail may have succeeded, and
      // repeating it could remove an object a concurrent publish just created.
      await attemptOnce(() =>
        this.#operations.deleteObject({ bucket: this.#bucket, key }),
      );
      this.mutations.deletes += 1;
    } catch (error) {
      throw new RemoteError(`Could not delete ${key}: ${describe(error)}`, {
        cause: error,
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DEFAULT_RETRY_POLICY };
