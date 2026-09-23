import path from "node:path";
import * as yaml from "js-yaml";

import { MEDIA_WORKSPACE_DIR } from "../../src/lib/content/paths.js";
import { normalizeOrigin } from "../../src/lib/site.js";
import "../lib/env.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import {
  ensureDirectory,
  formatBytes,
  writeFileAtomic,
} from "../lib/fs-util.js";
import {
  EXIT,
  RemoteError,
  ValidationError,
  type ExitCode,
} from "../lib/errors.js";
import {
  IMMUTABLE_MEDIA_CACHE_CONTROL,
  MEDIA_META_CACHE_CONTROL,
} from "../release/buckets.js";
import { sha256Hex } from "../release/digest.js";
import { acquireMutationLease } from "../release/lease.js";
import type { PortsFactory } from "../release/ports.js";
import {
  PreconditionFailedError,
  type PutOptions,
  type PutResult,
  type StorageAdapter,
} from "../release/storage.js";
import {
  runCli,
  isDirectRun,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import { planMedia, type MediaPlan, type MediaPlanEntry } from "./plan.js";
import { assertCredit, assertOptionalNote } from "./alt.js";
import type { CoverReference } from "./meta.js";

/** The `cover` block, ready to paste under the frontmatter delimiters. */
export function renderCoverBlock(cover: CoverReference): string {
  return yaml.dump({ cover }, { lineWidth: 100, noRefs: true });
}

/**
 * `media:add` — sanitise, transcode and (only with `--apply`) upload one file.
 *
 * The default run is a complete local rehearsal: it strips metadata, derives
 * every responsive variant, writes them into the author's media workspace, and
 * prints exactly what would be uploaded. Nothing leaves the machine, and no
 * credentials are needed. `--apply` uploads the same bytes it just wrote, so
 * what was reviewed is what is published.
 *
 * The public-access warning before an upload is not optional. Media objects are
 * readable by anyone with the URL as soon as they land, whether or not an
 * article references them yet, so an unreferenced private draft attachment
 * becomes public the moment it is uploaded.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "alt",
    kind: "string",
    value: "<text>",
    summary: "Required. 4–160 characters describing what the image shows.",
  },
  {
    name: "cover",
    kind: "boolean",
    summary: "Also produce the fixed 16:9 1600×900 cover variant.",
  },
  {
    name: "credit",
    kind: "string",
    value: "<text>",
    summary: "Optional credit or attribution line.",
  },
  {
    name: "source",
    kind: "string",
    value: "<text>",
    summary: "Optional note about where the file came from.",
  },
];

export const mediaAddDefinition: CliDefinition = {
  command: "media:add",
  summary:
    "Sanitise a media file, derive responsive variants and plan its upload.",
  usage: [
    "media:add <file> --alt <text> [--cover] [--credit <text>] [--apply] [--json]",
  ],
  flags: FLAGS,
  notes: [
    "Without --apply nothing is uploaded; derivatives are written to .ani-content/workspace/media.",
    "The public media bucket is world-readable: never upload unpublished or sensitive material.",
  ],
  handler: handleMediaAdd,
};

export interface UploadSummary {
  readonly uploaded: number;
  readonly reused: number;
  readonly bytes: number;
}

async function handleMediaAdd(context: CliContext): Promise<ExitCode> {
  const { reporter, flags, positionals } = context;

  const fileArgument = positionals[0];
  if (fileArgument === undefined) {
    throw new ValidationError(
      'media:add needs a file path, e.g. `pnpm media:add photo.jpg --alt "…"`.',
    );
  }
  if (positionals.length > 1) {
    throw new ValidationError("media:add takes exactly one file.");
  }

  const filePath = path.resolve(process.cwd(), fileArgument);
  const alt = flags.required("alt");
  const cover = flags.boolean("cover");
  const credit = flags.string("credit");
  const source = flags.string("source");

  if (credit !== undefined) assertCredit(credit);
  if (source !== undefined) assertOptionalNote(source, "Source", 200);

  const plan = await planMedia({
    filePath,
    alt,
    cover,
    images: context.dependencies.images,
    now: context.dependencies.now(),
    mediaOrigin: normalizeOrigin(
      context.env.withDefault(
        "PUBLIC_MEDIA_ORIGIN",
        "https://media.example.invalid",
      ),
    ),
    ...(credit === undefined ? {} : { credit }),
    ...(source === undefined ? {} : { source }),
  });

  reporter.heading(
    `media/${plan.sourceSha256} (${plan.detected.label}, ${formatBytes(plan.totalBytes)})`,
  );
  for (const warning of plan.warnings) reporter.note(`warning: ${warning}`);

  const written = await writeLocalDerivatives(plan);
  for (const entry of written) {
    reporter.action("write", entry.localPath, {
      detail: `${entry.entry.role}${entry.entry.width === undefined ? "" : ` ${entry.entry.width}×${entry.entry.height ?? ""}`}`,
      bytes: entry.entry.bytes,
    });
  }

  let upload: UploadSummary | null = null;
  if (context.apply) {
    reporter.heading("Uploading to the public media bucket");
    reporter.note(
      "warning: objects in the media bucket are publicly readable the moment they are uploaded, whether or not an article references them yet.",
    );
  }
  upload = await uploadPlanWhenApplied({
    apply: context.apply,
    plan,
    ports: context.dependencies.ports,
    now: context.dependencies.now,
  });

  if (plan.cover !== null) {
    reporter.heading("Cover for frontmatter");
    reporter.note(renderCoverBlock(plan.cover));
  }
  reporter.heading("Markdown image");
  reporter.note(plan.markdown);

  const parts = [
    `${plan.entries.length} object(s), ${formatBytes(plan.totalBytes)}`,
    context.apply
      ? `uploaded ${upload?.uploaded ?? 0}, reused ${upload?.reused ?? 0}`
      : "local derivatives written, nothing uploaded",
  ];
  if (plan.cover !== null) parts.push("cover ready");
  reporter.setSummary(`${plan.sourceSha256}: ${parts.join("; ")}.`);

  return EXIT.OK;
}

/**
 * Upload a media plan while holding the same content-bucket lease used by
 * publish, rollback and cleanup. The `apply` gate lives inside this helper so
 * a dry run cannot even construct remote ports, let alone acquire the lease.
 */
export async function uploadPlanWhenApplied(options: {
  readonly apply: boolean;
  readonly plan: MediaPlan;
  readonly ports: PortsFactory;
  readonly now: () => Date;
}): Promise<UploadSummary | null> {
  if (!options.apply) return null;

  const ports = options.ports.create({
    role: "author",
    content: true,
    media: true,
    dryRun: false,
  });
  const lease = await acquireMutationLease({
    storage: ports.content,
    operation: "media-add",
    now: options.now,
  });

  try {
    return await uploadPlan(options.plan, ports.media, () =>
      lease.renewIfNeeded(),
    );
  } finally {
    await lease.release();
  }
}

interface WrittenDerivative {
  readonly entry: MediaPlanEntry;
  readonly localPath: string;
}

/**
 * Write the derivatives into `.ani-content/workspace/media/<sha>/`.
 *
 * These files are what `--apply` uploads and what a later `content:new
 * --cover-src` resolves its dimensions from, so they are written on every run,
 * dry or not.
 */
async function writeLocalDerivatives(
  plan: MediaPlan,
): Promise<WrittenDerivative[]> {
  const directory = path.join(MEDIA_WORKSPACE_DIR, plan.sourceSha256);
  await ensureDirectory(directory);

  const written: WrittenDerivative[] = [];
  for (const entry of plan.entries) {
    const payload = plan.payloads.get(entry.key);
    if (payload === undefined) {
      throw new ValidationError(
        `The plan has no payload for ${entry.key}; refusing to write a partial asset.`,
      );
    }
    const fileName = entry.path.split("/").at(-1) ?? "asset";
    const localPath = path.join(directory, fileName);
    await writeFileAtomic(localPath, payload);
    written.push({ entry, localPath });
  }

  return written;
}

/**
 * The error a content-addressed object earns when it no longer holds the bytes
 * its own name claims. Named separately so both paths that detect it — the size
 * the bucket reports and the digest of the bytes it returns — say the same
 * thing, and say *which* rule was broken.
 */
function immutableObjectChanged(entry: MediaPlanEntry): ValidationError {
  return new ValidationError(
    `${entry.key} already exists with different content. Derived media objects (the responsive variants and the sanitised original) are content-addressed and immutable, so this key must always hold exactly the bytes its digest names; only meta.json may be rewritten. Refusing to overwrite it.`,
  );
}

/**
 * Upload every object in the plan.
 *
 * Exported so the two conditional-write rules can be tested directly: the
 * immutable objects must be created-if-absent, and `meta.json` must be
 * rewritable. Both are decided here and nowhere else.
 */
export async function uploadPlan(
  plan: MediaPlan,
  storage: StorageAdapter,
  beforeObject?: () => Promise<void>,
): Promise<UploadSummary> {
  let uploaded = 0;
  let reused = 0;
  let bytes = 0;

  for (const entry of plan.entries) {
    await beforeObject?.();
    const payload = plan.payloads.get(entry.key);
    if (payload === undefined) {
      throw new ValidationError(`The plan has no payload for ${entry.key}.`);
    }

    const isMeta = entry.role === "meta";
    const cacheControl = isMeta
      ? MEDIA_META_CACHE_CONTROL
      : IMMUTABLE_MEDIA_CACHE_CONTROL;

    if (isMeta) {
      /*
       * `meta.json` is the one media object the format declares mutable: it
       * carries the alt text and the credit, and `MEDIA_META_CACHE_CONTROL`
       * says `must-revalidate` for exactly that reason. Writing it with
       * `If-None-Match: *` contradicted its own declared semantics — a second
       * `media:add --apply` with a corrected `--alt` could never succeed, and
       * the error it produced blamed content addressing for a rewrite that is
       * supposed to be legal.
       *
       * The rewrite is a compare-and-swap when the bucket reports an ETag, so a
       * concurrent edit loses the race instead of silently overwriting a value
       * nobody read. An object that exists without an ETag cannot be updated
       * safely at all, and is refused rather than overwritten blindly.
       */
      const existing = await storage.head(entry.key);
      const base: PutOptions = { contentType: entry.contentType, cacheControl };
      let request: PutOptions;
      if (existing === null) {
        request = { ...base, ifNoneMatch: true };
      } else {
        const etag = existing.etag;
        if (etag === null || etag.length === 0) {
          throw new RemoteError(
            `${entry.key} exists but ${storage.label} reported no ETag for it, so the metadata rewrite cannot be made conditional. Refusing to overwrite it blindly.`,
          );
        }
        request = { ...base, ifMatch: etag };
      }

      let metaResult: PutResult;
      try {
        metaResult = await storage.put(entry.key, payload, request);
      } catch (error) {
        if (!(error instanceof PreconditionFailedError)) throw error;
        throw new RemoteError(
          `${entry.key} changed while this run was writing it (${error.reason === "exists" ? "another run created it" : "another run rewrote it"}). Nothing was written for that object; re-run the command to write the metadata again.`,
          { cause: error },
        );
      }

      if (metaResult.created) {
        uploaded += 1;
        bytes += payload.byteLength;
      } else {
        reused += 1;
      }
      continue;
    }

    // A derived object — a responsive variant or the sanitised original — is
    // content-addressed and immutable: the key names the bytes it holds.
    try {
      const result = await storage.put(entry.key, payload, {
        contentType: entry.contentType,
        cacheControl,
        ifNoneMatch: true,
      });
      if (result.created) {
        uploaded += 1;
        bytes += payload.byteLength;
      } else {
        reused += 1;
      }
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;

      /*
       * Already present: identical content is an idempotent skip. Anything else
       * means the key no longer addresses what it names, which only the
       * immutable objects can be refused for — meta.json never reaches here.
       *
       * The size is compared from the metadata first, so an object that is
       * simply not the size this key's bytes must be is reported as the
       * immutability violation it is, rather than as a read that ran into the
       * byte limit the read was given.
       */
      const existingHead = await storage.head(entry.key);
      if (existingHead !== null && existingHead.bytes !== payload.byteLength) {
        throw immutableObjectChanged(entry);
      }

      const existing = await storage.get(entry.key, {
        maxBytes: payload.byteLength,
      });
      if (sha256Hex(existing.bytes) !== entry.sha256) {
        throw immutableObjectChanged(entry);
      }
      reused += 1;
    }
  }

  return { uploaded, reused, bytes };
}

export async function runMediaAdd(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(mediaAddDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runMediaAdd(process.argv.slice(2));
}
