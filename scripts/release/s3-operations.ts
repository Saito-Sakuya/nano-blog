import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { RemoteError } from "../lib/errors.js";

/**
 * The S3-compatible R2 calls, one thin wrapper per operation.
 *
 * This is the lowest seam in the release tooling: a test replaces these five
 * functions and the whole S3-backed adapter above them can be exercised with
 * scripted pages, 412s and 503s, with no network and no credentials.
 *
 * One page per call. Pagination is deliberately *not* hidden here — the loop
 * over `IsTruncated` and the continuation token lives in `S3Storage`, where it
 * can be tested by returning two pages from a fake.
 */

export interface ListedObject {
  readonly key: string;
  readonly bytes: number;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

export interface ListPage {
  readonly objects: readonly ListedObject[];
  readonly truncated: boolean;
  readonly nextContinuationToken: string | null;
}

export interface RemoteObjectHead {
  readonly bytes: number;
  readonly etag: string | null;
  readonly contentType: string | null;
}

export interface RemoteObjectBody {
  readonly bytes: Uint8Array;
  readonly etag: string | null;
  readonly contentType: string | null;
}

/**
 * One entry of a `ListObjectsV2` page, as the SDK types it: every field is
 * optional, because the shape comes from a response body rather than from
 * anything this project controls.
 */
export interface RawListedEntry {
  readonly Key?: string | undefined;
  readonly Size?: number | undefined;
  readonly ETag?: string | undefined;
  readonly LastModified?: Date | undefined;
}

/**
 * Map one page of raw entries to `ListedObject`s, refusing malformed ones.
 *
 * Cleanup decides what may be deleted from the key, the size and the age of
 * each object, so an entry that does not carry all three cannot be allowed to
 * stand in for one that does. Filling the gaps — `key: ""`, `bytes: 0`,
 * `lastModified: null` — is how a listing that lost a field becomes a plan that
 * deletes the wrong object: an empty key matches nothing and a null timestamp
 * never ages, so the object silently drifts outside every retention rule.
 *
 * The ETag is the one field that may legitimately be absent: no retention rule
 * reads it, and it is reported as `null` rather than invented.
 */
export function toListedObjects(
  entries: readonly RawListedEntry[] | undefined,
): ListedObject[] {
  return (entries ?? []).map((entry, index) => {
    const key = entry.Key;
    if (typeof key !== "string" || key.length === 0) {
      throw new RemoteError(
        `The listing returned an entry at position ${index} with no key; refusing to work from a listing that cannot be trusted.`,
      );
    }

    const bytes = entry.Size;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      throw new RemoteError(
        `${key}: the listing did not report a valid size (${String(bytes)}); refusing to work from a listing that cannot be trusted.`,
      );
    }

    const lastModified = entry.LastModified;
    if (
      !(lastModified instanceof Date) ||
      Number.isNaN(lastModified.getTime())
    ) {
      throw new RemoteError(
        `${key}: the listing did not report when the object was last modified; refusing to guess whether it is old enough to delete.`,
      );
    }

    return { key, bytes, etag: entry.ETag ?? null, lastModified };
  });
}

export interface PutObjectRequest {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: boolean;
}

export interface S3Operations {
  readonly label: string;
  listObjects(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly continuationToken?: string;
    readonly maxKeys?: number;
  }): Promise<ListPage>;
  headObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<RemoteObjectHead | null>;
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly maxBytes?: number;
  }): Promise<RemoteObjectBody | null>;
  putObject(input: PutObjectRequest): Promise<{ readonly etag: string | null }>;
  deleteObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<void>;
}

export interface R2Credentials {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly label?: string;
}

/** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * An S3 client bound to R2.
 *
 * `region` is `auto`, as R2 requires. The SDK's own retry is switched off
 * (`maxAttempts: 1`) so that exactly one retry policy exists in this project —
 * the explicit, logged one in `lib/retry.ts` — rather than two multiplying each
 * other. Request checksums are only calculated when the protocol requires them,
 * which keeps payloads plain `PUT` bodies rather than `aws-chunked` streams.
 */
export function createR2Client(credentials: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(credentials.accountId),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SdkMetadataCarrier {
  readonly $metadata?: { readonly httpStatusCode?: number };
  readonly name?: string;
}

export function statusOfSdkError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as SdkMetadataCarrier).$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

export function nameOfSdkError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as SdkMetadataCarrier).name;
  return typeof name === "string" ? name : undefined;
}

/** A 404 or `NoSuchKey`/`NotFound` — the object simply is not there. */
export function isMissingObjectError(error: unknown): boolean {
  const status = statusOfSdkError(error);
  if (status === 404) return true;
  const name = nameOfSdkError(error);
  return name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket";
}

/**
 * Collect a response body into a byte array, refusing to buffer more than
 * `maxBytes`. An object that lies about its size cannot exhaust memory.
 */
async function readBodyBytes(
  body: unknown,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  const declaredLimit = maxBytes ?? Number.POSITIVE_INFINITY;

  if (body === undefined || body === null) {
    throw new RemoteError("The response carried no body.");
  }

  if (body instanceof Uint8Array) {
    if (body.byteLength > declaredLimit) {
      throw new RemoteError(
        `Body is ${body.byteLength} bytes, above the ${declaredLimit}-byte limit.`,
      );
    }
    return body;
  }

  const transformable = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (typeof transformable.transformToByteArray === "function") {
    const bytes = await transformable.transformToByteArray();
    if (bytes.byteLength > declaredLimit) {
      throw new RemoteError(
        `Body is ${bytes.byteLength} bytes, above the ${declaredLimit}-byte limit.`,
      );
    }
    return bytes;
  }

  const iterable = body as AsyncIterable<unknown>;
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of iterable) {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : chunk instanceof Uint8Array
            ? chunk
            : null;
      if (bytes === null) {
        throw new RemoteError(
          "The response produced a chunk that is not bytes.",
        );
      }
      total += bytes.byteLength;
      if (total > declaredLimit) {
        throw new RemoteError(`Body exceeds the ${declaredLimit}-byte limit.`);
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }

  throw new RemoteError("The response body could not be read.");
}

/** The real R2-backed operations, over `@aws-sdk/client-s3`. */
export function createR2Operations(credentials: R2Credentials): S3Operations {
  const client = createR2Client(credentials);
  const label = credentials.label ?? "r2";

  return {
    label,

    async listObjects(input) {
      const output = await client.send(
        new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: input.prefix,
          ...(input.continuationToken === undefined
            ? {}
            : { ContinuationToken: input.continuationToken }),
          ...(input.maxKeys === undefined ? {} : { MaxKeys: input.maxKeys }),
        }),
      );

      const objects = toListedObjects(output.Contents);

      return {
        objects,
        truncated: output.IsTruncated === true,
        nextContinuationToken: output.NextContinuationToken ?? null,
      };
    },

    async headObject(input) {
      try {
        const output = await client.send(
          new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
        return {
          bytes: output.ContentLength ?? 0,
          etag: output.ETag ?? null,
          contentType: output.ContentType ?? null,
        };
      } catch (error) {
        if (isMissingObjectError(error)) return null;
        throw error;
      }
    },

    async getObject(input) {
      try {
        const output = await client.send(
          new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
        return {
          bytes: await readBodyBytes(output.Body, input.maxBytes),
          etag: output.ETag ?? null,
          contentType: output.ContentType ?? null,
        };
      } catch (error) {
        if (isMissingObjectError(error)) return null;
        throw error;
      }
    },

    async putObject(input) {
      const output = await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ...(input.cacheControl === undefined
            ? {}
            : { CacheControl: input.cacheControl }),
          ...(input.ifMatch === undefined ? {} : { IfMatch: input.ifMatch }),
          ...(input.ifNoneMatch === true ? { IfNoneMatch: "*" } : {}),
        }),
      );
      return { etag: output.ETag ?? null };
    },

    async deleteObject(input) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
      } catch (error) {
        if (isMissingObjectError(error)) return;
        throw new RemoteError(
          `Could not delete ${input.key}: ${describe(error)}`,
          { cause: error },
        );
      }
    },
  };
}
