import { z } from "astro/zod";

import { parseContentPath } from "../../src/lib/content/paths.js";
import { ValidationError } from "../lib/errors.js";
import {
  assertNoCaseCollisions,
  assertSafeRelativePath,
  isMediaObjectPath,
} from "../lib/safe-paths.js";
import { compareCodePoints } from "../lib/unicode.js";
import {
  canonicalDigest,
  isContentDigest,
  isReleaseId,
  parseReleaseId,
  releaseIdFor,
  SHA256_HEX_PATTERN,
} from "./digest.js";

/**
 * The release manifest.
 *
 * The manifest is the contract between the machine that publishes and the
 * machine that builds. It is validated strictly on the way out and on the way
 * in, unknown top-level fields included: a manifest that carries a field nobody
 * reads is a manifest whose author believed something that is not true.
 *
 * The content digest is computed over the canonical JSON of the version and
 * file list only. `createdAt` and `releaseId` are deliberately outside it, so
 * republishing identical content produces an identical digest — and therefore
 * an identical release id suffix, which is what makes a republish an idempotent
 * skip rather than a second release.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export const MANIFEST_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * One content type for both source extensions. Nothing downstream branches on
 * it — the renderer looks at the file extension — and there is no registered
 * media type for MDX to use instead.
 */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** Hard limits. Exceeding any of them fails immediately, never partially. */
export const CONTENT_LIMITS = {
  manifestBytes: 5 * 1024 * 1024,
  contentFileBytes: 2 * 1024 * 1024,
  maxContentFiles: 10_000,
  releaseBytes: 250 * 1024 * 1024,
} as const;

export interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface ManifestMedia {
  readonly path: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: number;
  readonly releaseId: string;
  readonly createdAt: string;
  readonly baseReleaseId: string | null;
  readonly contentPrefix: string;
  readonly contentDigest: string;
  readonly files: readonly ManifestFile[];
  readonly media: readonly ManifestMedia[];
}

const sha256Field = z
  .string()
  .regex(SHA256_HEX_PATTERN, "Must be 64 lowercase hex characters.");

/**
 * Strict: an unknown top-level key is an error, not a field that quietly does
 * nothing.
 */
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  releaseId: z
    .string()
    .refine(isReleaseId, "Must be YYYYMMDDTHHmmssZ-<12 hex>."),
  createdAt: z.iso.datetime({ offset: true }),
  baseReleaseId: z
    .string()
    .refine(isReleaseId, "Must be a release id or null.")
    .nullable(),
  contentPrefix: z.string(),
  contentDigest: z
    .string()
    .refine(isContentDigest, "Must be sha256:<64 lowercase hex>."),
  files: z.array(
    z.strictObject({
      path: z.string(),
      sha256: sha256Field,
      bytes: z.number().int().nonnegative(),
      contentType: z.string().min(1),
    }),
  ),
  media: z.array(
    z.strictObject({
      path: z.string(),
      sha256: sha256Field,
    }),
  ),
});

export interface ManifestVerification {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function releaseContentPrefix(releaseId: string): string {
  return `releases/${releaseId}/content/`;
}

export function manifestObjectKey(releaseId: string): string {
  return `releases/${releaseId}/manifest.json`;
}

/** The bucket key of one content file inside a release. */
export function contentObjectKey(
  releaseId: string,
  relativePath: string,
): string {
  assertSafeRelativePath(relativePath, "Content path");
  return `${releaseContentPrefix(releaseId)}${relativePath}`;
}

/** The release id a `releases/<id>/…` key belongs to, or null. */
export function releaseIdFromKey(key: string): string | null {
  const match = /^releases\/([^/]+)\//u.exec(key);
  const releaseId = match?.[1];
  return releaseId !== undefined && isReleaseId(releaseId) ? releaseId : null;
}

export function contentTypeForPath(path: string): string {
  return path.endsWith(".mdx") || path.endsWith(".md")
    ? MARKDOWN_CONTENT_TYPE
    : "application/octet-stream";
}

/**
 * The digest input.
 *
 * Everything that must not change the digest — timestamps — is absent, and the
 * file list is in its canonical order, so this is a pure function of content.
 */
export function contentDigestInput(
  files: readonly ManifestFile[],
  media: readonly ManifestMedia[],
): {
  schemaVersion: number;
  files: readonly ManifestFile[];
  media: readonly ManifestMedia[];
} {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    files: [...files].sort((a, b) => compareCodePoints(a.path, b.path)),
    media: [...media].sort((a, b) => compareCodePoints(a.path, b.path)),
  };
}

export function contentDigestOf(
  files: readonly ManifestFile[],
  media: readonly ManifestMedia[],
): string {
  return canonicalDigest(contentDigestInput(files, media));
}

export interface BuildManifestInput {
  readonly createdAt: Date;
  readonly baseReleaseId: string | null;
  readonly files: readonly ManifestFile[];
  readonly media: readonly ManifestMedia[];
  /** Supply to assert an already-decided id; omit to derive it from the digest. */
  readonly releaseId?: string;
}

/**
 * Build a manifest, deriving the release id from the content digest unless one
 * was supplied — in which case the id's digest suffix must agree with the
 * digest that was computed, or the build fails.
 */
export function buildManifest(input: BuildManifestInput): ReleaseManifest {
  const files = [...input.files].sort((a, b) =>
    compareCodePoints(a.path, b.path),
  );
  const media = [...input.media].sort((a, b) =>
    compareCodePoints(a.path, b.path),
  );
  const contentDigest = contentDigestOf(files, media);
  const releaseId =
    input.releaseId ?? releaseIdFor(input.createdAt, contentDigest);

  const parsed = parseReleaseId(releaseId);
  if (parsed === null) {
    throw new ValidationError(
      `Release id ${JSON.stringify(releaseId)} is not well formed.`,
    );
  }
  const expectedSuffix = contentDigest.slice(
    "sha256:".length,
    "sha256:".length + 12,
  );
  if (parsed.digest12 !== expectedSuffix) {
    throw new ValidationError(
      `Release id ${releaseId} does not match the content digest ${contentDigest}: the id must end in ${expectedSuffix}.`,
    );
  }

  const manifest: ReleaseManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    releaseId,
    createdAt: input.createdAt.toISOString(),
    baseReleaseId: input.baseReleaseId,
    contentPrefix: releaseContentPrefix(releaseId),
    contentDigest,
    files,
    media,
  };

  const verification = verifyManifest(manifest);
  if (!verification.ok) {
    throw new ValidationError(`The release manifest is not valid.`, {
      issues: verification.issues,
    });
  }

  return manifest;
}

/**
 * Verify a parsed manifest against every fixed rule.
 *
 * Returns the full list of problems rather than the first, because a manifest
 * that is wrong is usually wrong in more than one place.
 */
export function verifyManifest(
  manifest: ReleaseManifest,
): ManifestVerification {
  const issues: string[] = [];
  const push = (message: string): void => {
    issues.push(message);
  };

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    push(
      `schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, but is ${manifest.schemaVersion}.`,
    );
  }

  if (!isReleaseId(manifest.releaseId)) {
    push(
      `releaseId ${JSON.stringify(manifest.releaseId)} is not a valid release id.`,
    );
  }

  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    push(
      `createdAt ${JSON.stringify(manifest.createdAt)} is not an ISO instant.`,
    );
  }

  if (manifest.baseReleaseId !== null && !isReleaseId(manifest.baseReleaseId)) {
    push(
      `baseReleaseId ${JSON.stringify(manifest.baseReleaseId)} is neither null nor a release id.`,
    );
  }

  const expectedPrefix = releaseContentPrefix(manifest.releaseId);
  if (manifest.contentPrefix !== expectedPrefix) {
    push(
      `contentPrefix must be ${expectedPrefix}, but is ${manifest.contentPrefix}.`,
    );
  }

  if (!isContentDigest(manifest.contentDigest)) {
    push(
      `contentDigest ${JSON.stringify(manifest.contentDigest)} is malformed.`,
    );
  }

  // --- files ---------------------------------------------------------------

  const filePaths: string[] = [];
  let totalBytes = 0;

  for (const [index, file] of manifest.files.entries()) {
    filePaths.push(file.path);

    try {
      assertSafeRelativePath(file.path, `files[${index}].path`);
    } catch (error) {
      push(error instanceof Error ? error.message : String(error));
      continue;
    }

    try {
      parseContentPath(file.path);
    } catch (error) {
      push(
        `files[${index}].path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!SHA256_HEX_PATTERN.test(file.sha256)) {
      push(`files[${index}].sha256 is not 64 lowercase hex characters.`);
    }

    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      push(`files[${index}].bytes must be a non-negative integer.`);
    } else {
      totalBytes += file.bytes;
      if (file.bytes > CONTENT_LIMITS.contentFileBytes) {
        push(
          `files[${index}] (${file.path}) is ${file.bytes} bytes, above the ${CONTENT_LIMITS.contentFileBytes}-byte per-file limit.`,
        );
      }
    }

    if (file.contentType !== contentTypeForPath(file.path)) {
      push(
        `files[${index}] (${file.path}) declares contentType ${JSON.stringify(file.contentType)}; ${JSON.stringify(contentTypeForPath(file.path))} is expected.`,
      );
    }

    const previous = manifest.files[index - 1];
    if (
      previous !== undefined &&
      compareCodePoints(previous.path, file.path) >= 0
    ) {
      push(
        `files must be sorted by Unicode code point and free of duplicates: ${previous.path} precedes ${file.path}.`,
      );
    }
  }

  if (manifest.files.length > CONTENT_LIMITS.maxContentFiles) {
    push(
      `The release holds ${manifest.files.length} content files, above the ${CONTENT_LIMITS.maxContentFiles}-file limit.`,
    );
  }

  if (totalBytes > CONTENT_LIMITS.releaseBytes) {
    push(
      `The release holds ${totalBytes} content bytes, above the ${CONTENT_LIMITS.releaseBytes}-byte limit.`,
    );
  }

  try {
    assertNoCaseCollisions(filePaths, "The manifest file list");
  } catch (error) {
    push(error instanceof Error ? error.message : String(error));
  }

  // --- media ---------------------------------------------------------------

  const mediaPaths: string[] = [];
  for (const [index, entry] of manifest.media.entries()) {
    mediaPaths.push(entry.path);

    if (!isMediaObjectPath(entry.path)) {
      push(
        `media[${index}].path ${JSON.stringify(entry.path)} must be /media/<64 hex>/<file>.`,
      );
      continue;
    }

    if (!SHA256_HEX_PATTERN.test(entry.sha256)) {
      push(`media[${index}].sha256 is not 64 lowercase hex characters.`);
      continue;
    }

    const fromPath = entry.path.split("/")[2] ?? "";
    if (fromPath !== entry.sha256) {
      push(
        `media[${index}] (${entry.path}) declares sha256 ${entry.sha256}, which does not match the digest in its own path.`,
      );
    }

    const previous = manifest.media[index - 1];
    if (
      previous !== undefined &&
      compareCodePoints(previous.path, entry.path) >= 0
    ) {
      push(
        `media must be sorted by path and free of duplicates: ${previous.path} precedes ${entry.path}.`,
      );
    }
  }

  try {
    assertNoCaseCollisions(mediaPaths, "The manifest media list");
  } catch (error) {
    push(error instanceof Error ? error.message : String(error));
  }

  // --- digest --------------------------------------------------------------

  if (isContentDigest(manifest.contentDigest)) {
    const recomputed = contentDigestOf(manifest.files, manifest.media);
    if (recomputed !== manifest.contentDigest) {
      push(
        `contentDigest ${manifest.contentDigest} does not match the digest of the file list (${recomputed}).`,
      );
    }

    const parsed = parseReleaseId(manifest.releaseId);
    if (parsed !== null) {
      const expectedSuffix = manifest.contentDigest.slice(
        "sha256:".length,
        "sha256:".length + 12,
      );
      if (parsed.digest12 !== expectedSuffix) {
        push(
          `releaseId ${manifest.releaseId} does not embed the content digest; expected the suffix ${expectedSuffix}.`,
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Parse and verify in one step; throws with every issue attached. */
export function parseManifest(
  value: unknown,
  label = "manifest.json",
): ReleaseManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${label} does not match the manifest schema.`, {
      issues: result.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
      ),
    });
  }

  const manifest = result.data;
  const verification = verifyManifest(manifest);
  if (!verification.ok) {
    throw new ValidationError(`${label} is not a valid release manifest.`, {
      issues: verification.issues,
    });
  }

  return manifest;
}

/** Number of objects a release stores: its files plus the manifest itself. */
export function releaseContentBytes(manifest: ReleaseManifest): number {
  return manifest.files.reduce((total, file) => total + file.bytes, 0);
}
