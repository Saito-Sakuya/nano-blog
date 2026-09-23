import path from "node:path";

import {
  ANI_CONTENT_DIR,
  CONTENT_WORKSPACE_DIR,
  MEDIA_WORKSPACE_DIR,
} from "../../src/lib/content/paths.js";
import { ValidationError } from "../lib/errors.js";
import {
  copyFileEntries,
  ensureDirectory,
  listFilesRecursive,
  pathExists,
  readBytes,
  readJsonFile,
  replaceDirectoryAtomically,
  withStagingDirectory,
  writeJsonFile,
} from "../lib/fs-util.js";
import { canonicalDigest, sha256Hex } from "../release/digest.js";
import {
  CONTENT_LIMITS,
  contentTypeForPath,
  type ManifestFile,
} from "../release/manifest.js";
import { assertReleaseTextEncoding } from "../release/release-plan.js";

/**
 * The author workspace.
 *
 * A workspace is a directory of content plus one fact: which release it was
 * copied from. That fact is what makes overwriting safe — a checkout may
 * replace the workspace only while the workspace still equals the base it
 * claims, so a morning's editing cannot be silently discarded by an afternoon's
 * `content:pull --checkout`.
 *
 * The base digest is computed over the content files the same way a release
 * digest is, but without media: media is not what an author edits in the
 * workspace, and including it would make "locally edited" true after any media
 * upload.
 */

export const WORKSPACE_ROOT = path.join(ANI_CONTENT_DIR, "workspace");
export const WORKSPACE_STATE_FILE = path.join(WORKSPACE_ROOT, "workspace.json");

export interface WorkspaceState {
  readonly schemaVersion: number;
  /** The release this workspace was checked out from; null for an empty one. */
  readonly baseReleaseId: string | null;
  /** The content digest of that base, for detecting local edits. */
  readonly baseContentDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceContentSummary {
  readonly digest: string;
  readonly fileCount: number;
  readonly bytes: number;
  readonly files: readonly ManifestFile[];
}

/**
 * Digest of a content directory, in the same shape as a release's.
 *
 * This is a *local* comparison digest, not a release id input: it deliberately
 * excludes the media list, which is not part of the author's working copy.
 */
export async function summarizeWorkspaceContent(
  contentDir: string,
): Promise<WorkspaceContentSummary> {
  if (!(await pathExists(contentDir))) {
    return {
      digest: canonicalDigest({ schemaVersion: 1, files: [] }),
      fileCount: 0,
      bytes: 0,
      files: [],
    };
  }

  const entries = await listFilesRecursive(contentDir);
  const files: ManifestFile[] = [];

  for (const entry of entries) {
    if (!/\.(md|mdx)$/u.test(entry.relativePath)) continue;
    const bytes = await readBytes(entry.absolutePath);
    assertReleaseTextEncoding(bytes, entry.relativePath);
    files.push({
      path: entry.relativePath,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      contentType: contentTypeForPath(entry.relativePath),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let total = 0;
  for (const file of files) {
    total += file.bytes;
    if (file.bytes > CONTENT_LIMITS.contentFileBytes) {
      throw new ValidationError(
        `${file.path} is ${file.bytes} bytes, above the ${CONTENT_LIMITS.contentFileBytes}-byte per-file limit.`,
      );
    }
  }

  return {
    digest: canonicalDigest({ schemaVersion: 1, files }),
    fileCount: files.length,
    bytes: total,
    files,
  };
}

export async function readWorkspaceState(): Promise<WorkspaceState | null> {
  if (!(await pathExists(WORKSPACE_STATE_FILE))) return null;
  const value = await readJsonFile(WORKSPACE_STATE_FILE);

  if (typeof value !== "object" || value === null) {
    throw new ValidationError(`${WORKSPACE_STATE_FILE} is not a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const baseReleaseId = record["baseReleaseId"];
  const baseContentDigest = record["baseContentDigest"];

  if (baseReleaseId !== null && typeof baseReleaseId !== "string") {
    throw new ValidationError(
      `${WORKSPACE_STATE_FILE}: baseReleaseId must be a string or null.`,
    );
  }
  if (baseContentDigest !== null && typeof baseContentDigest !== "string") {
    throw new ValidationError(
      `${WORKSPACE_STATE_FILE}: baseContentDigest must be a string or null.`,
    );
  }

  return {
    schemaVersion:
      typeof record["schemaVersion"] === "number" ? record["schemaVersion"] : 1,
    baseReleaseId,
    baseContentDigest,
    createdAt:
      typeof record["createdAt"] === "string"
        ? record["createdAt"]
        : new Date(0).toISOString(),
    updatedAt:
      typeof record["updatedAt"] === "string"
        ? record["updatedAt"]
        : new Date(0).toISOString(),
  };
}

export async function writeWorkspaceState(
  state: WorkspaceState,
): Promise<void> {
  await writeJsonFile(WORKSPACE_STATE_FILE, state);
}

export interface WorkspaceStatus {
  readonly exists: boolean;
  readonly state: WorkspaceState | null;
  readonly content: WorkspaceContentSummary;
  /** True when the content no longer matches the digest it was checked out at. */
  readonly locallyEdited: boolean;
}

/**
 * The digest of a workspace that has never held anything.
 *
 * A workspace created by `content:new` has no base release, so its recorded
 * base digest is null. Comparing against this constant is what makes "the
 * author has written something since" true for such a workspace — otherwise a
 * checkout would silently discard the first article an author ever wrote.
 */
export const EMPTY_CONTENT_DIGEST = canonicalDigest({
  schemaVersion: 1,
  files: [],
});

export async function workspaceStatus(): Promise<WorkspaceStatus> {
  const exists = await pathExists(CONTENT_WORKSPACE_DIR);
  const state = await readWorkspaceState();
  const content = await summarizeWorkspaceContent(CONTENT_WORKSPACE_DIR);

  const baseDigest = state?.baseContentDigest ?? EMPTY_CONTENT_DIGEST;

  return {
    exists,
    state,
    content,
    locallyEdited: exists && baseDigest !== content.digest,
  };
}

export interface CreateWorkspaceOptions {
  readonly now: Date;
  readonly baseReleaseId?: string | null;
  readonly baseContentDigest?: string | null;
}

/**
 * Create the workspace, or return the existing one untouched.
 *
 * An existing workspace is never reset here: `content:new` may run in a
 * workspace an author has been editing for weeks, and losing that would be
 * unforgivable.
 */
export async function ensureWorkspace(
  options: CreateWorkspaceOptions,
): Promise<{ readonly created: boolean; readonly state: WorkspaceState }> {
  const existing = await readWorkspaceState();
  if (existing !== null) return { created: false, state: existing };

  await ensureDirectory(CONTENT_WORKSPACE_DIR);

  const state: WorkspaceState = {
    schemaVersion: 1,
    baseReleaseId: options.baseReleaseId ?? null,
    baseContentDigest: options.baseContentDigest ?? null,
    createdAt: options.now.toISOString(),
    updatedAt: options.now.toISOString(),
  };
  await writeWorkspaceState(state);
  return { created: true, state };
}

export interface CheckoutOptions {
  /** The verified content directory of the release being checked out. */
  readonly sourceContentDir: string;
  readonly releaseId: string;
  readonly now: Date;
  /** Replace a workspace that has been edited. Refused by default. */
  readonly force?: boolean;
}

export interface CheckoutResult {
  readonly state: WorkspaceState;
  readonly fileCount: number;
}

/**
 * Copy a verified release into the workspace.
 *
 * Refuses when the workspace has local edits, unless `force` is set. The
 * comparison is against the digest recorded at checkout, so "edited" means the
 * author changed something — not merely that a media file was added.
 */
export async function checkoutRelease(
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  const status = await workspaceStatus();

  if (status.exists && status.locallyEdited && options.force !== true) {
    throw new ValidationError(
      `The workspace has local edits (its content digest is ${status.content.digest}, but the base release ${status.state?.baseReleaseId ?? "(none)"} was checked out at ${status.state?.baseContentDigest ?? EMPTY_CONTENT_DIGEST}). Refusing to overwrite it. Publish or back up those changes first.`,
    );
  }

  const sourceEntries = (
    await listFilesRecursive(options.sourceContentDir)
  ).filter((entry) => /\.(md|mdx)$/u.test(entry.relativePath));

  await ensureDirectory(WORKSPACE_ROOT);

  await withStagingDirectory(
    { parent: WORKSPACE_ROOT, prefix: "checkout.staging" },
    async (staging) => {
      const contentDir = path.join(staging, "content");
      await copyFileEntries(contentDir, sourceEntries);
      await replaceDirectoryAtomically({
        staging: contentDir,
        target: CONTENT_WORKSPACE_DIR,
        root: WORKSPACE_ROOT,
        label: "Author workspace",
      });
    },
  );

  const summary = await summarizeWorkspaceContent(CONTENT_WORKSPACE_DIR);
  const state: WorkspaceState = {
    schemaVersion: 1,
    baseReleaseId: options.releaseId,
    baseContentDigest: summary.digest,
    createdAt: status.state?.createdAt ?? options.now.toISOString(),
    updatedAt: options.now.toISOString(),
  };
  await writeWorkspaceState(state);

  return { state, fileCount: summary.fileCount };
}

export { CONTENT_WORKSPACE_DIR, MEDIA_WORKSPACE_DIR };
