import { listFilesRecursive, readBytes } from "../lib/fs-util.js";
import {
  ConflictError,
  toValidationError,
  ValidationError,
} from "../lib/errors.js";
import { assertSafeRelativePath } from "../lib/safe-paths.js";
import { parseContentPath } from "../../src/lib/content/paths.js";
import { sha256Hex } from "./digest.js";
import {
  buildManifest,
  contentObjectKey,
  contentTypeForPath,
  CONTENT_LIMITS,
  manifestObjectKey,
  releaseContentBytes,
  type ManifestMedia,
  type ReleaseManifest,
} from "./manifest.js";
import { PreconditionFailedError, type StorageAdapter } from "./storage.js";

/**
 * Turning a validated workspace into a release plan, and then into objects.
 *
 * A plan is pure: given the same directory, the same instant and the same base
 * release, it produces the same manifest and the same object keys. Everything
 * that talks to the network is in `reconcileRelease` (reads only) and
 * `uploadRelease` (immutable creates), which is what lets `content:publish`
 * print a complete, verifiable plan without writing anything.
 *
 * "Same key, different bytes" is treated as a hard failure rather than an
 * overwrite. A release key is derived from the content digest, so a collision
 * means something is wrong — an interrupted upload, or an object written by
 * something other than this tooling — and silently replacing it would destroy
 * the only copy of what was there.
 */

const ALLOWED_TOP_LEVEL = ["posts", "pages"] as const;

export interface PlannedObject {
  readonly key: string;
  /** Path inside the release's `content/` directory. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface ReleasePlan {
  readonly contentDir: string;
  readonly createdAt: Date;
  readonly baseReleaseId: string | null;
  readonly manifest: ReleaseManifest;
  readonly manifestKey: string;
  readonly manifestBytes: number;
  readonly files: readonly PlannedObject[];
  readonly totalBytes: number;
}

export interface BuildReleasePlanOptions {
  readonly contentDir: string;
  readonly baseReleaseId: string | null;
  readonly createdAt: Date;
  readonly media?: readonly ManifestMedia[];
  readonly releaseId?: string;
}

/**
 * Release text is UTF-8 without a BOM and uses LF endings.
 *
 * Checked here as well as in `content:validate`, because this is the boundary
 * where bytes become immutable: after this point the file is in a release and
 * cannot be corrected.
 */
export function assertReleaseTextEncoding(
  bytes: Uint8Array,
  label: string,
): void {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new ValidationError(
      `${label} starts with a UTF-8 byte order mark; releases must not.`,
    );
  }
  for (const byte of bytes) {
    if (byte === 0x0d) {
      throw new ValidationError(
        `${label} contains a CR byte; releases must use LF line endings.`,
      );
    }
  }
}

export async function buildReleasePlan(
  options: BuildReleasePlanOptions,
): Promise<ReleasePlan> {
  const entries = await listFilesRecursive(options.contentDir);
  const files: PlannedObject[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const relativePath = entry.relativePath;
    assertSafeRelativePath(relativePath, "Content path");

    const topLevel = relativePath.split("/")[0] ?? "";
    if (!(ALLOWED_TOP_LEVEL as readonly string[]).includes(topLevel)) {
      throw new ValidationError(
        `${relativePath} is directly under the content root; every content file lives under ${ALLOWED_TOP_LEVEL.join("/")} or ${ALLOWED_TOP_LEVEL.map((name) => `${name}/…`).join(", ")}.`,
      );
    }

    try {
      parseContentPath(relativePath);
    } catch (error) {
      throw toValidationError(
        error,
        `${relativePath} is not a usable content path`,
      );
    }

    if (seen.has(relativePath)) {
      throw new ValidationError(
        `${relativePath} appears twice in the release plan.`,
      );
    }
    seen.add(relativePath);

    if (entry.bytes > CONTENT_LIMITS.contentFileBytes) {
      throw new ValidationError(
        `${relativePath} is ${entry.bytes} bytes, above the ${CONTENT_LIMITS.contentFileBytes}-byte per-file limit.`,
      );
    }

    const bytes = await readBytes(entry.absolutePath);
    assertReleaseTextEncoding(bytes, relativePath);

    files.push({
      key: contentObjectKey("", relativePath).replace("releases//content/", ""),
      relativePath,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      contentType: contentTypeForPath(relativePath),
    });
  }

  if (files.length > CONTENT_LIMITS.maxContentFiles) {
    throw new ValidationError(
      `The workspace holds ${files.length} content files, above the ${CONTENT_LIMITS.maxContentFiles}-file limit.`,
    );
  }

  const manifest = buildManifest({
    createdAt: options.createdAt,
    baseReleaseId: options.baseReleaseId,
    files: files.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
      contentType: file.contentType,
    })),
    media: options.media ?? [],
    ...(options.releaseId === undefined
      ? {}
      : { releaseId: options.releaseId }),
  });

  const manifestBytes = Buffer.byteLength(
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  if (manifestBytes > CONTENT_LIMITS.manifestBytes) {
    throw new ValidationError(
      `The manifest is ${manifestBytes} bytes, above the ${CONTENT_LIMITS.manifestBytes}-byte limit.`,
    );
  }

  const totalBytes = releaseContentBytes(manifest);
  if (totalBytes > CONTENT_LIMITS.releaseBytes) {
    throw new ValidationError(
      `The release holds ${totalBytes} bytes, above the ${CONTENT_LIMITS.releaseBytes}-byte limit.`,
    );
  }

  const releaseId = manifest.releaseId;

  return {
    contentDir: options.contentDir,
    createdAt: options.createdAt,
    baseReleaseId: options.baseReleaseId,
    manifest,
    manifestKey: manifestObjectKey(releaseId),
    manifestBytes,
    files: files.map((file) => ({
      ...file,
      key: contentObjectKey(releaseId, file.relativePath),
    })),
    totalBytes,
  };
}

export interface ReconcileResult {
  readonly toUpload: readonly PlannedObject[];
  readonly reused: readonly PlannedObject[];
  readonly uploadBytes: number;
  readonly reusedBytes: number;
  readonly manifestExists: boolean;
  readonly manifestIdentical: boolean;
  readonly remoteObjectCount: number;
}

/**
 * Compare a plan with what is already in the bucket.
 *
 * Reused objects are downloaded and hashed rather than trusted on size alone:
 * "the same key" is not evidence that the bytes match, and the whole point of
 * an immutable release is that its contents are known.
 */
export async function reconcileRelease(
  plan: ReleasePlan,
  storage: StorageAdapter,
): Promise<ReconcileResult> {
  const prefix = plan.manifest.contentPrefix;
  const remote = new Map<string, { bytes: number; sha256: string | null }>();

  for await (const object of storage.list(prefix)) {
    remote.set(object.key, { bytes: object.bytes, sha256: null });
  }

  const toUpload: PlannedObject[] = [];
  const reused: PlannedObject[] = [];
  let uploadBytes = 0;
  let reusedBytes = 0;

  for (const file of plan.files) {
    const existing = remote.get(file.key);
    if (existing === undefined) {
      toUpload.push(file);
      uploadBytes += file.bytes;
      continue;
    }

    const data = await storage.get(file.key, {
      maxBytes: CONTENT_LIMITS.contentFileBytes,
    });
    const remoteSha = sha256Hex(data.bytes);
    if (remoteSha !== file.sha256) {
      throw new ValidationError(
        `${file.key} already exists with different bytes (remote sha256 ${remoteSha}, planned ${file.sha256}). A release object is immutable; refusing to overwrite it.`,
      );
    }

    reused.push(file);
    reusedBytes += file.bytes;
  }

  const manifestHead = await storage.head(plan.manifestKey);
  let manifestIdentical = false;
  if (manifestHead !== null) {
    const data = await storage.get(plan.manifestKey, {
      maxBytes: CONTENT_LIMITS.manifestBytes,
    });
    manifestIdentical =
      Buffer.from(data.bytes).toString("utf8") ===
        JSON.stringify(plan.manifest, null, 2) + "\n" ||
      Buffer.from(data.bytes).toString("utf8") ===
        JSON.stringify(plan.manifest, null, 2);
  }

  return {
    toUpload,
    reused,
    uploadBytes,
    reusedBytes,
    manifestExists: manifestHead !== null,
    manifestIdentical,
    remoteObjectCount: remote.size,
  };
}

export interface UploadResult {
  readonly created: number;
  readonly reused: number;
  readonly bytesWritten: number;
}

/**
 * Write a release's content objects, then its manifest.
 *
 * Every object is created with `If-None-Match: *`. A lost precondition means
 * somebody (or a previous attempt) already created the key, so the object is
 * re-read and compared: identical content is an idempotent skip, different
 * content stops the release.
 */
export async function uploadRelease(
  plan: ReleasePlan,
  storage: StorageAdapter,
  options: {
    readonly cacheControl: string;
    readonly beforeObject?: () => Promise<void>;
    readonly onObject?: (object: PlannedObject, created: boolean) => void;
  },
): Promise<UploadResult> {
  let created = 0;
  let reused = 0;
  let bytesWritten = 0;

  const writeImmutable = async (
    key: string,
    body: Uint8Array,
    contentType: string,
    sha256: string,
  ): Promise<boolean> => {
    try {
      const result = await storage.put(key, body, {
        contentType,
        cacheControl: options.cacheControl,
        ifNoneMatch: true,
      });
      return result.created;
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;

      // Lost the race, or a retry landed. Compare and continue if identical.
      const existing = await storage.get(key, {
        maxBytes: Math.max(body.byteLength, 1),
      });
      const existingSha = sha256Hex(existing.bytes);
      if (existingSha !== sha256) {
        throw new ValidationError(
          `${key} appeared while this release was uploading and holds different bytes. Refusing to overwrite an immutable object.`,
        );
      }
      return false;
    }
  };

  for (const file of plan.files) {
    await options.beforeObject?.();
    const bytes = await readBytes(
      resolveWithinContent(plan.contentDir, file.relativePath),
    );
    const actualSha256 = sha256Hex(bytes);
    if (bytes.byteLength !== file.bytes || actualSha256 !== file.sha256) {
      throw new ConflictError(
        `${file.relativePath} changed after the release plan was built (planned ${file.bytes} bytes / ${file.sha256}, now ${bytes.byteLength} bytes / ${actualSha256}). Nothing from the changed file was uploaded; rebuild the plan and publish again.`,
      );
    }
    const wasCreated = await writeImmutable(
      file.key,
      bytes,
      file.contentType,
      file.sha256,
    );
    if (wasCreated) {
      created += 1;
      bytesWritten += bytes.byteLength;
    } else {
      reused += 1;
    }
    options.onObject?.(file, wasCreated);
  }

  const manifestBody = Buffer.from(
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    "utf8",
  );
  const manifestSha = sha256Hex(manifestBody);
  await options.beforeObject?.();
  const manifestCreated = await writeImmutable(
    plan.manifestKey,
    manifestBody,
    "application/json; charset=utf-8",
    manifestSha,
  );

  if (manifestCreated) {
    created += 1;
    bytesWritten += manifestBody.byteLength;
  } else {
    reused += 1;
  }

  return { created, reused, bytesWritten };
}

function resolveWithinContent(
  contentDir: string,
  relativePath: string,
): string {
  assertSafeRelativePath(relativePath, "Content path");
  return `${contentDir}${contentDir.endsWith("/") || contentDir.endsWith("\\") ? "" : "/"}${relativePath}`;
}
