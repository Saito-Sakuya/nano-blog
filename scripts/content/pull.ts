import path from "node:path";

import "../lib/env.js";
import {
  ANI_CONTENT_DIR,
  CONTENT_CACHE_DIR,
} from "../../src/lib/content/paths.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import {
  EXIT,
  UsageError,
  ValidationError,
  type ExitCode,
} from "../lib/errors.js";
import { formatBytes, pathExists, readJsonFile } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import { readActive } from "../release/active.js";
import { isReleaseId } from "../release/digest.js";
import { pullReleaseMedia } from "../release/media-pull.js";
import {
  materializeRuntime,
  pullRelease,
  releaseCachePaths,
  readVerifiedCache,
  SOURCE_FILE_NAME,
  type SourceRecord,
} from "../release/pull.js";
import { checkoutRelease } from "./workspace.js";

/**
 * `content:pull` — fetch the active release (or a named one) into the local
 * runtime.
 *
 * This is how a build machine or an author obtains the content the site is
 * actually made of. It only ever reads: the storage adapter is wrapped in the
 * dry-run overlay, so a bug in this command cannot write to the bucket even in
 * principle.
 *
 * The materialisation is atomic. Everything is downloaded into a staging
 * directory, verified against the manifest — size, key, SHA-256 and content
 * digest — and only then swapped into `.ani-content/runtime`. A failed pull
 * leaves the previous runtime exactly as it was; it never leaves a half-updated
 * one.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "release",
    kind: "string",
    value: "<id>",
    summary: "Pull a specific release instead of the active one.",
  },
  {
    name: "checkout",
    kind: "boolean",
    summary:
      "Also copy the release into the author workspace, refusing if the workspace has local edits.",
  },
  {
    name: "offline",
    kind: "boolean",
    summary: "Use only the verified local cache; never contact R2.",
  },
];

export const pullDefinition: CliDefinition = {
  command: "content:pull",
  summary:
    "Download, verify and materialise a content release into .ani-content/runtime.",
  usage: ["content:pull [--release <id>] [--checkout] [--offline] [--json]"],
  flags: FLAGS,
  notes: [
    "Reads only; this command can never write to the bucket.",
    "Without --offline a failure is fatal: a build never silently falls back to a stale cache.",
  ],
  handler: handlePull,
};

async function runtimeReleaseId(): Promise<string | null> {
  const sourceFile = path.join(ANI_CONTENT_DIR, "runtime", SOURCE_FILE_NAME);
  if (!(await pathExists(sourceFile))) return null;
  const value = await readJsonFile(sourceFile);
  if (typeof value !== "object" || value === null) return null;
  const releaseId = (value as Partial<SourceRecord>).releaseId;
  return typeof releaseId === "string" ? releaseId : null;
}

async function handlePull(context: CliContext): Promise<ExitCode> {
  const { reporter, flags } = context;
  const now = context.dependencies.now();

  const requested = flags.string("release");
  if (requested !== undefined && !isReleaseId(requested)) {
    throw new UsageError(
      `--release expects a release id of the form YYYYMMDDTHHmmssZ-<12 hex>, but received ${JSON.stringify(requested)}.`,
    );
  }

  const offline = flags.boolean("offline");

  if (offline) {
    const releaseId = requested ?? (await runtimeReleaseId());
    if (releaseId === null) {
      throw new ValidationError(
        "--offline needs a release id: pass --release <id>, or materialise a runtime first so the previous release can be reused.",
      );
    }

    const cached = await readVerifiedCache(CONTENT_CACHE_DIR, releaseId);
    if (cached === null) {
      throw new ValidationError(
        `.ani-content/cache/releases/${releaseId} is missing or does not match its manifest, and --offline forbids downloading it.`,
      );
    }

    reporter.note(
      `offline: using the verified cache for ${releaseId}; no network access, no remote verification.`,
    );
    const media = await pullReleaseMedia({
      manifest: cached.manifest,
      cacheDirectory: cached.directory,
      offline: true,
    });
    const result = await materializeRuntime({
      sourceContentDir: cached.contentDir,
      runtimeDir: path.join(ANI_CONTENT_DIR, "runtime"),
      root: ANI_CONTENT_DIR,
      mode: "r2",
      releaseId,
      contentDigest: cached.manifest.contentDigest,
      instant: now,
      media: { sourceDir: media.directory, index: media.index },
      offline: true,
    });
    recordActions(
      context,
      cached.manifest.files.length,
      result.bytes,
      releaseId,
      result.fileCount,
      result.mediaFileCount,
      result.mediaBytes,
    );
    reporter.setSummary(
      `Materialised ${releaseId} from the local cache (offline): ${result.fileCount} content file(s), ${result.mediaFileCount} media file(s), ${formatBytes(result.bytes + result.mediaBytes)}.`,
    );
    return EXIT.OK;
  }

  const ports = context.dependencies.ports.create({
    role: "build",
    content: true,
    media: true,
    dryRun: true,
  });

  let releaseId = requested;
  let expectedDigest: string | undefined;

  if (releaseId === undefined) {
    const active = await readActive(ports.content);
    if (active.pointer === null) {
      throw new ValidationError(
        "active.json does not exist yet, so there is no active release to pull. Publish one first, or pass --release <id>.",
      );
    }
    releaseId = active.pointer.releaseId;
    expectedDigest = active.pointer.contentDigest;
    reporter.note(
      `active release: ${releaseId} (${active.pointer.contentDigest})`,
    );
  }

  const pulled = await pullRelease({
    storage: ports.content,
    releaseId,
    cacheRoot: CONTENT_CACHE_DIR,
    ...(expectedDigest === undefined ? {} : { expectedDigest }),
  });

  reporter.note(
    pulled.fromCache
      ? `cache hit: ${releaseCachePaths(CONTENT_CACHE_DIR, releaseId).directory} already matches the manifest`
      : `downloaded ${pulled.manifest.files.length} file(s), ${formatBytes(pulled.bytes)}`,
  );

  const media = await pullReleaseMedia({
    manifest: pulled.manifest,
    cacheDirectory: pulled.directory,
    storage: ports.media,
  });
  reporter.note(
    media.fromCache
      ? `media cache hit: ${media.fileCount} verified file(s)`
      : `downloaded and verified ${media.fileCount} media file(s), ${formatBytes(media.bytes)}`,
  );

  const result = await materializeRuntime({
    sourceContentDir: pulled.contentDir,
    runtimeDir: path.join(ANI_CONTENT_DIR, "runtime"),
    root: ANI_CONTENT_DIR,
    mode: "r2",
    releaseId,
    contentDigest: pulled.manifest.contentDigest,
    instant: now,
    media: { sourceDir: media.directory, index: media.index },
  });

  recordActions(
    context,
    pulled.manifest.files.length,
    result.bytes,
    releaseId,
    result.fileCount,
    result.mediaFileCount,
    result.mediaBytes,
  );

  if (flags.boolean("checkout")) {
    const checkout = await checkoutRelease({
      sourceContentDir: pulled.contentDir,
      releaseId,
      now,
    });
    reporter.action("write", "author workspace", {
      detail: `checked out ${releaseId} (${checkout.fileCount} file(s))`,
    });
  }

  reporter.setSummary(
    `Materialised ${releaseId}: ${result.fileCount} content file(s), ${result.mediaFileCount} media file(s), ${formatBytes(result.bytes + result.mediaBytes)}${flags.boolean("checkout") ? ", workspace checked out" : ""}.`,
  );
  return EXIT.OK;
}

function recordActions(
  context: CliContext,
  downloaded: number,
  bytes: number,
  releaseId: string,
  materialised: number,
  materialisedMedia: number,
  mediaBytes: number,
): void {
  context.reporter.action("download", `releases/${releaseId}/`, {
    detail: `${downloaded} content object(s) verified`,
    bytes,
  });
  context.reporter.action("write", ".ani-content/runtime", {
    detail: `${materialised} content file(s) and ${materialisedMedia} media file(s) materialised`,
    bytes: bytes + mediaBytes,
  });
}

export async function runPull(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(pullDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runPull(process.argv.slice(2));
}
