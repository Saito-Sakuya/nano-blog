import "../lib/env.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import {
  ConflictError,
  CredentialsError,
  EXIT,
  UsageError,
  ValidationError,
  type ExitCode,
} from "../lib/errors.js";
import { formatBytes } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import {
  MANIFEST_CONTENT_TYPE,
  type ManifestMedia,
} from "../release/manifest.js";
import { IMMUTABLE_RELEASE_CACHE_CONTROL } from "../release/buckets.js";
import {
  applyActivation,
  buildActivePointer,
  pointsAt,
  readActive,
  type ActiveState,
} from "../release/active.js";
import { deployRetryInstruction, type DeployHook } from "../release/deploy.js";
import { canonicalDigest, isReleaseId, sha256Hex } from "../release/digest.js";
import { acquireMutationLease, type MutationLease } from "../release/lease.js";
import {
  buildReleasePlan,
  reconcileRelease,
  uploadRelease,
} from "../release/release-plan.js";
import type { StorageAdapter } from "../release/storage.js";
import {
  mediaObjectKey,
  parseMediaMeta,
  type MediaMeta,
} from "../media/meta.js";
import {
  loadContentSource,
  resolveLocalSource,
  type ContentIssue,
  type ContentSourceKind,
} from "./load.js";
import {
  checkRedirectTable,
  collectMediaReferences,
  validateSource,
} from "./validate.js";
import { readWorkspaceState, writeWorkspaceState } from "./workspace.js";

/**
 * `content:publish` — build an immutable release and, with `--apply`, activate
 * it.
 *
 * The order is fixed and each step depends on the one before it:
 *
 *   1. validate the workspace, including media that must be fetched to be
 *      checked;
 *   2. confirm `active.json` still points at the release this workspace was
 *      checked out from — otherwise somebody else published in the meantime;
 *   3. upload content, then the manifest, then move the pointer with a
 *      compare-and-swap;
 *   4. trigger the deploy hook.
 *
 * A dry run performs the first two steps and prints the complete plan. Nothing
 * is uploaded and the hook is never contacted — the adapters are wrapped so
 * that a write is impossible, not merely unused.
 *
 * If the hook fails after the pointer has moved, the content stays active. It
 * is valid content; discarding it because a notification failed would be
 * worse. The command exits non-zero with the exact command that retries the
 * build.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "source",
    kind: "string",
    value: "<kind>",
    choices: ["workspace", "runtime", "fixtures", "directory"],
    summary: "Which content source to publish; defaults to the workspace.",
  },
  {
    name: "path",
    kind: "string",
    value: "<dir>",
    summary: "Publish a specific directory instead.",
  },
  {
    name: "deploy-only",
    kind: "boolean",
    summary:
      "Do not upload anything; re-trigger the deploy hook for an already-active release.",
  },
  {
    name: "release",
    kind: "string",
    value: "<id>",
    summary: "The release --deploy-only acts on. Must be the active release.",
  },
];

export const publishDefinition: CliDefinition = {
  command: "content:publish",
  summary:
    "Validate the workspace, plan an immutable release and (with --apply) publish and deploy it.",
  usage: [
    "content:publish [--json]",
    "content:publish --apply",
    "content:publish --deploy-only --release <id> --apply",
  ],
  flags: FLAGS,
  notes: [
    "Without --apply nothing is uploaded, no pointer is moved and the deploy hook is never contacted.",
    "A publish whose base release is no longer active is refused: it would discard somebody else’s release.",
  ],
  handler: handlePublish,
};

interface MediaLookup {
  readonly records: Map<string, { files: string[] }>;
  readonly issues: readonly ContentIssue[];
  readonly verified: boolean;
  readonly failure: CredentialsError | null;
}

async function handlePublish(context: CliContext): Promise<ExitCode> {
  const { reporter, flags } = context;

  if (flags.boolean("deploy-only")) {
    return handleDeployOnly(context, flags.required("release"));
  }

  const explicitKind = flags.string("source") as ContentSourceKind | undefined;
  const explicitPath = flags.string("path");

  const resolved = await resolveLocalSource({
    ...(explicitKind === undefined ? {} : { kind: explicitKind }),
    ...(explicitPath === undefined ? {} : { root: explicitPath }),
  });

  if (resolved.kind === "empty") {
    throw new ValidationError(
      "There is no workspace to publish. Create one with `pnpm content:new`, or run `pnpm content:pull --checkout` first.",
    );
  }

  if (resolved.kind !== "workspace") {
    reporter.note(
      `warning: publishing from ${resolved.label}, not the author workspace.`,
    );
  }

  const now = context.dependencies.now();
  const source = await loadContentSource({
    root: resolved.root,
    kind: resolved.kind,
  });

  // --- media ---------------------------------------------------------------

  const referenced = collectMediaReferences(source);
  const referencedDigests = [
    ...new Set(referenced.map((entry) => entry.sha256)),
  ];

  const extraMedia = new Map<string, { files: readonly string[] }>();
  for (const [digest, record] of source.mediaRecords) {
    extraMedia.set(digest, toFileList(record));
  }

  // Records the author's workspace does not have are fetched from the media
  // bucket: a release must not claim a cover whose bytes nobody has checked.
  // Without credentials the lookup reports "unverified" instead of failing, so
  // the dry run can still print the whole local plan.
  let remoteVerified = true;
  let credentialFailure: CredentialsError | null = null;
  let remoteMediaIssues: readonly ContentIssue[] = [];

  if (referencedDigests.length > 0) {
    const fetched: MediaLookup = await fetchMediaRecords(context, referenced);
    remoteVerified = fetched.verified;
    credentialFailure = fetched.failure;
    remoteMediaIssues = fetched.issues;
    for (const [digest, record] of fetched.records)
      extraMedia.set(digest, record);
  }

  // --- validation ----------------------------------------------------------

  const report = validateSource({
    source,
    now,
    publication: true,
    strictMedia: true,
    extraMedia,
  });

  // The redirect table is part of the deployed configuration, and a rule
  // pointing at a page this release will not build would be a 404 at the end of
  // a redirect. It is checked before anything is uploaded.
  const issues = [
    ...report.issues,
    ...remoteMediaIssues,
    ...(await checkRedirectTable(source)),
  ];
  const errorCount = issues.filter(
    (issue) => issue.severity === "error",
  ).length;

  for (const issue of issues) {
    reporter.action("verify", issue.file ?? resolved.label, {
      detail: `${issue.severity}${issue.field === undefined ? "" : ` ${issue.field}`}: ${issue.message}`,
    });
  }

  if (errorCount > 0) {
    throw new ValidationError(
      `The workspace does not pass validation (${errorCount} error(s)).`,
      {
        issues: issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.file ?? "(unknown)"}: ${issue.message}`),
      },
    );
  }

  // --- plan ----------------------------------------------------------------

  const workspaceState = await readWorkspaceState();
  const baseReleaseId = workspaceState?.baseReleaseId ?? null;

  const plan = await buildReleasePlan({
    contentDir: resolved.root,
    baseReleaseId,
    createdAt: now,
    media: referenced,
  });

  reporter.heading(`Release ${plan.manifest.releaseId}`);
  reporter.note(`  content digest : ${plan.manifest.contentDigest}`);
  reporter.note(`  base release   : ${baseReleaseId ?? "(none)"}`);
  reporter.note(`  files          : ${plan.files.length}`);
  reporter.note(`  media objects  : ${plan.manifest.media.length}`);

  if (!remoteVerified) {
    reporter.note(
      `remoteVerified: false — ${credentialFailure?.message ?? "R2 credentials are missing"}, so the plan was not compared with the bucket, the pointer was not read and the deploy hook was not resolved.`,
    );
  }

  // --- remote verification -------------------------------------------------

  let toUpload = plan.files;
  let reused: readonly { key: string; bytes: number }[] = [];
  let deploy: DeployHook | null = null;
  let contentStorage: StorageAdapter | null = null;
  let activeReleaseId: string | null = null;
  let initialActive: ActiveState | null = null;
  let lease: MutationLease | null = null;

  try {
    if (remoteVerified) {
      let ports;
      try {
        ports = context.dependencies.ports.create({
          role: "author",
          content: true,
          media: referencedDigests.length > 0,
          deploy: true,
          dryRun: context.dryRun,
        });
      } catch (error) {
        // Missing credentials degrade to an unverified local plan rather than
        // hiding it: the author can still see exactly what would be published,
        // and the exit code says it is not safe to apply.
        if (!(error instanceof CredentialsError)) throw error;
        credentialFailure = error;
        remoteVerified = false;
        reporter.note(`remoteVerified: false — ${error.message}`);
      }

      if (ports !== undefined) {
        contentStorage = ports.content;
        deploy = ports.deploy;

        if (!context.dryRun) {
          lease = await acquireMutationLease({
            storage: ports.content,
            operation: "publish",
            now: context.dependencies.now,
          });

          if (referenced.length > 0) {
            const lockedMedia = await inspectRemoteMedia(
              ports.media,
              referenced,
            );
            if (lockedMedia.issues.length > 0) {
              throw new ValidationError(
                "Remote media changed before the publish lease was acquired.",
                {
                  issues: lockedMedia.issues.map((issue) => issue.message),
                },
              );
            }
          }
        }

        const active = await readActive(ports.content);
        initialActive = active;
        activeReleaseId = active.pointer?.releaseId ?? null;

        if (baseReleaseId !== null && activeReleaseId !== baseReleaseId) {
          throw new ConflictError(
            `This workspace is based on release ${baseReleaseId}, but active.json now points at ${activeReleaseId ?? "(nothing)"}. Somebody else published in the meantime; refusing to overwrite their release. Run content:pull --checkout to move onto the current release.`,
          );
        }
        if (baseReleaseId === null && activeReleaseId !== null) {
          throw new ConflictError(
            `This workspace has no base release, but active.json already points at ${activeReleaseId}. An empty-based workspace must not replace an existing release; check the content out first.`,
          );
        }

        // Identical content is not published twice. The active release already
        // holds exactly these bytes, so a new release would duplicate storage and
        // move the pointer without changing the site. A rebuild can still be
        // requested with `--deploy-only --release <id> --apply`.
        if (
          active.pointer !== null &&
          active.pointer.contentDigest === plan.manifest.contentDigest
        ) {
          reporter.note(
            `the active release ${active.pointer.releaseId} already holds this content (${plan.manifest.contentDigest}); nothing to publish`,
          );
          reporter.setSummary(
            `No change: ${active.pointer.releaseId} already holds this content. Use --deploy-only --release ${active.pointer.releaseId} --apply to rebuild.`,
          );
          return EXIT.OK;
        }

        const reconcile = await reconcileRelease(plan, ports.content);
        toUpload = reconcile.toUpload;
        reused = reconcile.reused;

        reporter.heading("Plan");
        reporter.note(
          `  new objects    : ${reconcile.toUpload.length} (${formatBytes(reconcile.uploadBytes)})`,
        );
        reporter.note(
          `  reused objects : ${reconcile.reused.length} (${formatBytes(reconcile.reusedBytes)})`,
        );
        reporter.note(
          `  manifest       : ${reconcile.manifestIdentical ? "identical, will be skipped" : "will be written"}`,
        );
        reporter.note(
          `  active.json    : ${activeReleaseId ?? "(absent)"} → ${plan.manifest.releaseId}`,
        );
        reporter.note(
          `  deploy hook    : ${context.dryRun ? "not contacted (dry run)" : "will be triggered after activation"}`,
        );

        for (const object of reconcile.toUpload) {
          reporter.action("put", object.key, { bytes: object.bytes });
        }
        for (const object of reconcile.reused) {
          reporter.action("reuse", object.key, { bytes: object.bytes });
        }
      }
    }

    reporter.action("activate", "active.json", {
      detail: `${activeReleaseId ?? "(absent)"} → ${plan.manifest.releaseId}`,
    });

    if (context.dryRun) {
      reporter.setSummary(
        remoteVerified
          ? `Dry run: ${toUpload.length} object(s) to upload (${formatBytes(plan.totalBytes)}), ${reused.length} reused, release ${plan.manifest.releaseId}. Re-run with --apply to publish.`
          : `Dry run without credentials: the local release plan for ${plan.manifest.releaseId} is complete, but remoteVerified is false, so it is not safe to apply yet.`,
      );
      return remoteVerified ? EXIT.OK : EXIT.CREDENTIALS;
    }

    if (contentStorage === null || deploy === null || initialActive === null) {
      throw new CredentialsError(
        "Publishing needs R2 author credentials and a deploy hook URL; nothing was uploaded.",
      );
    }

    // --- upload --------------------------------------------------------------

    const upload = await uploadRelease(plan, contentStorage, {
      cacheControl: IMMUTABLE_RELEASE_CACHE_CONTROL,
      beforeObject: async () => {
        await lease?.renewIfNeeded();
      },
      onObject: (object, created) => {
        reporter.action(created ? "put" : "reuse", object.key, {
          bytes: object.bytes,
        });
      },
    });
    reporter.action("put", plan.manifestKey, {
      detail: "release manifest",
      bytes: plan.manifestBytes,
    });
    reporter.note(
      `uploaded ${upload.created} object(s), reused ${upload.reused}, ${formatBytes(upload.bytesWritten)} written`,
    );

    // --- activate ------------------------------------------------------------

    await lease?.renew();
    const pointer = buildActivePointer({
      releaseId: plan.manifest.releaseId,
      contentDigest: plan.manifest.contentDigest,
      instant: now,
    });
    const activation = await applyActivation(
      contentStorage,
      initialActive,
      pointer,
    );
    reporter.action("activate", "active.json", {
      detail: activation.unchanged
        ? `already pointed at ${pointer.releaseId}`
        : `now ${pointer.releaseId} (${MANIFEST_CONTENT_TYPE})`,
    });

    // --- remember the new base ----------------------------------------------

    if (resolved.kind === "workspace") {
      await writeWorkspaceState({
        schemaVersion: 1,
        baseReleaseId: pointer.releaseId,
        baseContentDigest: canonicalDigest({
          schemaVersion: 1,
          files: plan.manifest.files,
        }),
        createdAt: workspaceState?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }

    await lease?.release();
    lease = null;

    // --- deploy --------------------------------------------------------------

    await deploy.trigger({ releaseId: pointer.releaseId, reason: "publish" });
    reporter.action("deploy", "deploy hook", {
      detail: `request accepted for ${pointer.releaseId}`,
    });

    reporter.setSummary(
      `Published ${pointer.releaseId}: ${upload.created} object(s) uploaded, ${upload.reused} reused, active pointer moved, deploy request accepted.`,
    );
    return EXIT.OK;
  } finally {
    await lease?.release();
  }
}

function toFileList(
  record:
    | { original: { path: string }; variants: readonly { path: string }[] }
    | undefined,
): { files: string[] } {
  if (record === undefined) return { files: [] };
  return {
    files: [
      record.original.path.split("/").at(-1) ?? "",
      ...record.variants.map((variant) => variant.path.split("/").at(-1) ?? ""),
    ],
  };
}

/** Read and verify every remotely referenced media family. */
async function fetchMediaRecords(
  context: CliContext,
  references: readonly ManifestMedia[],
): Promise<MediaLookup> {
  const records = new Map<string, { files: string[] }>();

  let mediaStorage: StorageAdapter;
  try {
    const ports = context.dependencies.ports.create({
      role: "author",
      media: true,
      dryRun: true,
    });
    mediaStorage = ports.media;
  } catch (error) {
    if (error instanceof CredentialsError) {
      return { records, issues: [], verified: false, failure: error };
    }
    throw error;
  }

  const inspected = await inspectRemoteMedia(mediaStorage, references);
  return { ...inspected, verified: true, failure: null };
}

export async function inspectRemoteMedia(
  mediaStorage: StorageAdapter,
  references: readonly ManifestMedia[],
): Promise<Pick<MediaLookup, "records" | "issues">> {
  const records = new Map<string, { files: string[] }>();
  const issues: ContentIssue[] = [];
  const byDigest = new Map<string, Set<string>>();

  for (const reference of references) {
    const paths = byDigest.get(reference.sha256) ?? new Set<string>();
    paths.add(reference.path);
    byDigest.set(reference.sha256, paths);
  }

  const addIssue = (digest: string, message: string): void => {
    issues.push({
      severity: "error",
      code: "media-remote",
      file: `media/${digest}/meta.json`,
      message,
    });
  };

  for (const [digest, referencedPaths] of byDigest) {
    const key = `media/${digest}/meta.json`;
    const head = await mediaStorage.head(key);
    if (head === null) {
      addIssue(
        digest,
        `${key} does not exist in the media bucket; a local media record is not proof that the asset was uploaded.`,
      );
      continue;
    }

    let meta: MediaMeta;
    try {
      const data = await mediaStorage.get(key, { maxBytes: 64 * 1024 });
      meta = parseMediaMeta(
        JSON.parse(Buffer.from(data.bytes).toString("utf8")),
        key,
      );
    } catch (error) {
      addIssue(
        digest,
        `${key} could not be parsed and verified: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (meta.sourceSha256 !== digest) {
      addIssue(
        digest,
        `${key} declares source digest ${meta.sourceSha256}, not ${digest}.`,
      );
      continue;
    }

    records.set(digest, toFileList(meta));
    const assets = [meta.original, ...meta.variants];
    const declaredPaths = new Set(assets.map((asset) => asset.path));

    for (const referencedPath of referencedPaths) {
      if (!declaredPaths.has(referencedPath)) {
        addIssue(
          digest,
          `${referencedPath} is referenced by content but is not declared by ${key}.`,
        );
      }
    }

    for (const asset of assets) {
      const assetKey = mediaObjectKey(asset.path);
      const assetHead = await mediaStorage.head(assetKey);
      if (assetHead === null) {
        addIssue(
          digest,
          `${assetKey} is declared by ${key} but does not exist in the media bucket.`,
        );
      } else if (assetHead.bytes !== asset.bytes) {
        addIssue(
          digest,
          `${assetKey} is ${assetHead.bytes} bytes in the media bucket, but ${key} declares ${asset.bytes}.`,
        );
      } else {
        const data = await mediaStorage.get(assetKey, {
          maxBytes: asset.bytes,
        });
        const actualSha256 = sha256Hex(data.bytes);
        if (
          data.bytes.byteLength !== asset.bytes ||
          actualSha256 !== asset.sha256
        ) {
          addIssue(
            digest,
            `${assetKey} does not match ${key} (declared ${asset.bytes} bytes / ${asset.sha256}, remote ${data.bytes.byteLength} bytes / ${actualSha256}).`,
          );
        }
      }
    }
  }

  return { records, issues };
}

/** `--deploy-only`: retry the hook for a release that is already active. */
async function handleDeployOnly(
  context: CliContext,
  releaseId: string,
): Promise<ExitCode> {
  const { reporter } = context;

  if (!isReleaseId(releaseId)) {
    throw new UsageError(
      `--deploy-only expects a release id, but received ${JSON.stringify(releaseId)}.`,
    );
  }

  const ports = context.dependencies.ports.create({
    role: "author",
    content: true,
    deploy: true,
    dryRun: context.dryRun,
  });

  let lease: MutationLease | null = null;
  if (!context.dryRun) {
    lease = await acquireMutationLease({
      storage: ports.content,
      operation: "deploy-only",
      now: context.dependencies.now,
    });
  }

  try {
    const active = await readActive(ports.content);
    if (!pointsAt(active.pointer, releaseId)) {
      throw new ConflictError(
        `active.json points at ${active.pointer?.releaseId ?? "(nothing)"}, not at ${releaseId}. --deploy-only only re-triggers a build for content that is already live; it never activates anything.`,
      );
    }

    if (context.dryRun) {
      reporter.note(
        `active.json already points at ${releaseId}; --apply would trigger the deploy hook.`,
      );
      reporter.setSummary(
        `Dry run: would re-trigger the deploy hook for ${releaseId}.`,
      );
      return EXIT.OK;
    }

    await ports.deploy.trigger({ releaseId, reason: "deploy-only" });
    reporter.action("deploy", "deploy hook", {
      detail: `request accepted for ${releaseId}`,
    });
    reporter.setSummary(`Re-triggered the deploy hook for ${releaseId}.`);
    return EXIT.OK;
  } finally {
    await lease?.release();
  }
}

export { deployRetryInstruction };

export async function runPublish(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(publishDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runPublish(process.argv.slice(2));
}
