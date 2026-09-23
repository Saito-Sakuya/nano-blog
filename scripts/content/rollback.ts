import "../lib/env.js";
import { CONTENT_CACHE_DIR } from "../../src/lib/content/paths.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import { EXIT, UsageError, type ExitCode } from "../lib/errors.js";
import { formatBytes, listFilesRecursive } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import {
  applyActivation,
  buildActivePointer,
  readActive,
} from "../release/active.js";
import { isReleaseId } from "../release/digest.js";
import { acquireMutationLease, type MutationLease } from "../release/lease.js";
import {
  pullReleaseMedia,
  type ReleaseMediaBundle,
} from "../release/media-pull.js";
import { pullRelease, type PulledRelease } from "../release/pull.js";
import type { StorageAdapter } from "../release/storage.js";

/**
 * `content:rollback` — point the site at an older release.
 *
 * Rolling back moves one pointer. The older release is already in the bucket,
 * immutable and complete, so nothing is copied and nothing is rewritten: the
 * build simply reads the release the pointer names.
 *
 * Before the pointer moves, both the private content release and every public
 * media family it references are downloaded and verified in full. "The
 * manifest says it is fine" is not verification — content and media payloads
 * are compared with their declared hashes, while media records are strictly
 * parsed and cross-checked. A truncated or corrupted object is rejected rather
 * than activated.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "release",
    kind: "string",
    value: "<id>",
    summary: "Required. The release to activate.",
  },
];

export const rollbackDefinition: CliDefinition = {
  command: "content:rollback",
  summary: "Verify an existing release and point active.json back at it.",
  usage: [
    "content:rollback --release <id> [--json]",
    "content:rollback --release <id> --apply",
  ],
  flags: FLAGS,
  notes: [
    "Without --apply the pointer difference is shown and nothing is changed.",
    "The release content and every referenced media object are downloaded and verified before the pointer may move.",
  ],
  handler: handleRollback,
};

export interface VerifiedRollbackTarget {
  readonly content: PulledRelease;
  readonly media: ReleaseMediaBundle;
  /** All cached media bytes, including each meta.json record. */
  readonly mediaBytes: number;
}

export async function verifyRollbackTarget(options: {
  readonly content: StorageAdapter;
  readonly media: StorageAdapter;
  readonly releaseId: string;
  readonly cacheRoot: string;
}): Promise<VerifiedRollbackTarget> {
  const content = await pullRelease({
    storage: options.content,
    releaseId: options.releaseId,
    cacheRoot: options.cacheRoot,
  });
  const media = await pullReleaseMedia({
    manifest: content.manifest,
    cacheDirectory: content.directory,
    storage: options.media,
  });
  const mediaBytes =
    media.directory === null
      ? 0
      : (await listFilesRecursive(media.directory)).reduce(
          (total, entry) => total + entry.bytes,
          0,
        );
  return { content, media, mediaBytes };
}

async function handleRollback(
  context: CliContext,
  cacheRoot = CONTENT_CACHE_DIR,
): Promise<ExitCode> {
  const { reporter, flags } = context;

  const releaseId = flags.required("release");
  if (!isReleaseId(releaseId)) {
    throw new UsageError(
      `--release expects a release id of the form YYYYMMDDTHHmmssZ-<12 hex>, but received ${JSON.stringify(releaseId)}.`,
    );
  }

  const ports = context.dependencies.ports.create({
    role: "author",
    content: true,
    media: true,
    deploy: true,
    dryRun: context.dryRun,
  });

  const content: StorageAdapter = ports.content;
  let lease: MutationLease | null = null;
  if (!context.dryRun) {
    lease = await acquireMutationLease({
      storage: content,
      operation: "rollback",
      now: context.dependencies.now,
    });
  }

  try {
    const active = await readActive(content);
    const currentReleaseId = active.pointer?.releaseId ?? null;

    reporter.note(`active release: ${currentReleaseId ?? "(none)"}`);
    reporter.note(`target release: ${releaseId}`);

    // Verify content and every referenced media object before anything else.
    const verified = await verifyRollbackTarget({
      content,
      media: ports.media,
      releaseId,
      cacheRoot,
    });
    const pulled = verified.content;
    reporter.action("verify", `releases/${releaseId}/content/`, {
      detail: `${pulled.fileCount} content object(s) downloaded and hashed`,
      bytes: pulled.bytes,
    });
    reporter.action("verify", `media for ${releaseId}`, {
      detail: `${verified.media.fileCount} media object(s), including records, downloaded and verified`,
      bytes: verified.mediaBytes,
    });

    if (currentReleaseId === releaseId) {
      reporter.setSummary(
        `active.json already points at ${releaseId}; nothing changed.`,
      );
      return EXIT.OK;
    }

    reporter.action("activate", "active.json", {
      detail: `${currentReleaseId ?? "(none)"} → ${releaseId}`,
    });
    reporter.note(`content digest: ${pulled.manifest.contentDigest}`);
    reporter.note(
      `verified bytes: content ${formatBytes(pulled.bytes)}; media ${formatBytes(verified.mediaBytes)}`,
    );

    if (context.dryRun) {
      reporter.setSummary(
        `Dry run: active.json would move from ${currentReleaseId ?? "(none)"} to ${releaseId} and a Pages build would be triggered. Re-run with --apply to do it.`,
      );
      return EXIT.OK;
    }

    const pointer = buildActivePointer({
      releaseId,
      contentDigest: pulled.manifest.contentDigest,
      instant: context.dependencies.now(),
    });

    await lease?.renew();
    const activation = await applyActivation(content, active, pointer);
    reporter.action("activate", "active.json", {
      detail: activation.unchanged
        ? `already ${releaseId}`
        : `now ${releaseId}`,
    });

    await lease?.release();
    lease = null;

    await ports.deploy.trigger({ releaseId, reason: "rollback" });
    reporter.action("deploy", "deploy hook", {
      detail: `request accepted for ${releaseId}`,
    });

    reporter.setSummary(
      `Rolled back: active.json now points at ${releaseId} (was ${currentReleaseId ?? "(none)"}) and the Pages deploy request was accepted.`,
    );
    return EXIT.OK;
  } finally {
    await lease?.release();
  }
}

export async function runRollback(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
  options: { readonly cacheRoot?: string } = {},
): Promise<ExitCode> {
  const definition: CliDefinition = {
    ...rollbackDefinition,
    handler: (context) =>
      handleRollback(context, options.cacheRoot ?? CONTENT_CACHE_DIR),
  };
  return runCli(definition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runRollback(process.argv.slice(2));
}
