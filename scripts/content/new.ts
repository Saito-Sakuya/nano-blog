import path from "node:path";

import "../lib/env.js";
import {
  CONTENT_WORKSPACE_DIR,
  MEDIA_WORKSPACE_DIR,
  parseContentPath,
} from "../../src/lib/content/paths.js";
import {
  indexSchema,
  pageSchema,
  postSchema,
} from "../../src/lib/content/schema.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import {
  EXIT,
  toValidationError,
  UsageError,
  ValidationError,
  type ExitCode,
} from "../lib/errors.js";
import { pathExists, writeFileAtomic } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import { readMediaRecord, variantPath } from "../media/meta.js";
import { renderDocument } from "./frontmatter.js";
import { ensureWorkspace } from "./workspace.js";

/**
 * `content:new` — create one content file in the author workspace.
 *
 * The command writes a complete frontmatter block or it writes nothing. Every
 * value comes from a flag; nothing is invented, because an invented description
 * or placeholder body is exactly the kind of thing that reaches production
 * because nobody noticed it was a placeholder.
 *
 * A new document is always `draft: true`. Publishing is a separate, deliberate
 * act, and a file that appears in the feed the moment it is created is a file
 * nobody reviewed.
 */

const KINDS = ["post", "page", "index"] as const;
type Kind = (typeof KINDS)[number];

const FLAGS: readonly FlagSpec[] = [
  {
    name: "kind",
    kind: "string",
    value: "<kind>",
    choices: KINDS,
    summary: "Required. post, page or index.",
  },
  {
    name: "path",
    kind: "string",
    value: "<path>",
    summary: "Required. Path under posts/ or pages/.",
  },
  { name: "title", kind: "string", value: "<text>", summary: "Required." },
  {
    name: "description",
    kind: "string",
    value: "<text>",
    summary: "Required. 40–160 characters for posts and pages.",
  },
  {
    name: "published-at",
    kind: "string",
    value: "<iso>",
    summary:
      "Required for a post. ISO 8601 with an explicit offset, e.g. 2026-09-15T09:00:00+08:00.",
  },
  {
    name: "cover-src",
    kind: "string",
    value: "<media-path>",
    summary:
      "Required for a post. /media/<sha256>/1600.webp, as printed by media:add --cover.",
  },
  {
    name: "cover-alt",
    kind: "string",
    value: "<text>",
    summary: "Required for a post.",
  },
  {
    name: "credit",
    kind: "string",
    value: "<text>",
    summary: "Optional cover credit.",
  },
  {
    name: "tags",
    kind: "string",
    value: "<id:label>",
    repeatable: true,
    summary: "Repeatable. A tag as id:label, e.g. --tags web-dev:Web 开发.",
  },
  {
    name: "series",
    kind: "string",
    value: "<id:title:order>",
    summary:
      "Series membership as id:title:order, e.g. astro-notes:Astro 笔记:1.",
  },
  {
    name: "order",
    kind: "number",
    value: "<n>",
    summary: "Only for --kind index. Sort order among sibling directories.",
  },
];

export const newDefinition: CliDefinition = {
  command: "content:new",
  summary:
    "Create a schema-valid post, page or directory index in the author workspace.",
  usage: [
    "content:new --kind post --path posts/dev/web/a.md --title <text> --description <text> \\",
    "             --published-at <iso> --cover-src <media-path> --cover-alt <text> [--json]",
    "content:new --kind page  --path pages/lab/notes.md --title <text> --description <text>",
    "content:new --kind index --path posts/dev/_index.md --title <text> --description <text> [--order <n>]",
  ],
  flags: FLAGS,
  notes: [
    "Creates the workspace on first use, with baseReleaseId null.",
    "Writes draft: true always. Nothing is validated against the remote and nothing is uploaded.",
    "An existing file is never overwritten and never renamed; remove it yourself if that is what you want.",
  ],
  handler: handleNew,
};

function parseTags(values: readonly string[]): { id: string; label: string }[] {
  return values.map((value) => {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      throw new UsageError(
        `--tags expects id:label, but received ${JSON.stringify(value)}.`,
      );
    }
    return { id: value.slice(0, separator), label: value.slice(separator + 1) };
  });
}

function parseSeries(value: string): {
  id: string;
  title: string;
  order: number;
} {
  const parts = value.split(":");
  if (parts.length !== 3) {
    throw new UsageError(
      `--series expects id:title:order, but received ${JSON.stringify(value)}.`,
    );
  }
  const [id, title, rawOrder] = parts as [string, string, string];
  const order = Number(rawOrder);
  if (!Number.isInteger(order) || order <= 0) {
    throw new UsageError(
      `--series order must be a positive integer, but received ${JSON.stringify(rawOrder)}.`,
    );
  }
  return { id, title, order };
}

function assertKindPath(
  kind: Kind,
  relativePath: string,
  parsed: { isIndex: boolean; extension: string },
): void {
  const isPosts = relativePath.startsWith("posts/");
  const isPages = relativePath.startsWith("pages/");

  if (kind === "page") {
    if (!isPages) {
      throw new UsageError(
        `--kind page needs a path under pages/, but got ${relativePath}.`,
      );
    }
    if (parsed.isIndex) {
      throw new UsageError(
        'A page cannot be "_index.md"; directory indexes live under posts/.',
      );
    }
    return;
  }

  if (!isPosts) {
    throw new UsageError(
      `--kind ${kind} needs a path under posts/, but got ${relativePath}.`,
    );
  }
  if (kind === "post" && parsed.isIndex) {
    throw new UsageError(
      "--kind post is for an article; use --kind index for _index.md.",
    );
  }
  if (kind === "index" && !parsed.isIndex) {
    throw new UsageError("--kind index needs a _index.md path.");
  }
}

async function handleNew(context: CliContext): Promise<ExitCode> {
  const { reporter, flags, positionals } = context;

  // Every value this command writes comes from a named flag; a stray argument
  // is a mistyped flag, and silently ignoring it would create a file missing
  // whatever the author thought they had passed.
  if (positionals.length > 0) {
    throw new UsageError(
      `content:new takes no positional arguments, but received ${positionals.map((value) => JSON.stringify(value)).join(", ")}. Quote values containing spaces.`,
    );
  }

  const kind = flags.required("kind") as Kind;
  const relativePath = flags.required("path").replace(/\\/gu, "/");
  const title = flags.required("title");
  const description = flags.required("description");

  let parsedPath;
  try {
    parsedPath = parseContentPath(relativePath);
  } catch (error) {
    throw toValidationError(error, "The path is not usable");
  }
  assertKindPath(kind, relativePath, parsedPath);

  const absolutePath = path.join(
    CONTENT_WORKSPACE_DIR,
    ...relativePath.split("/"),
  );
  if (await pathExists(absolutePath)) {
    throw new ValidationError(
      `${relativePath} already exists in the workspace. content:new never overwrites or renames.`,
    );
  }

  const now = context.dependencies.now();
  const workspace = await ensureWorkspace({ now });
  reporter.note(
    workspace.created
      ? `created a new workspace (baseReleaseId: null) at ${CONTENT_WORKSPACE_DIR}`
      : `using the existing workspace (baseReleaseId: ${workspace.state.baseReleaseId ?? "null"})`,
  );

  const tags = parseTags(flags.list("tags"));
  const seriesFlag = flags.string("series");
  const credit = flags.string("credit");

  let frontmatter: Record<string, unknown>;
  const body = "";

  if (kind === "post") {
    const publishedAt = flags.required("published-at");
    const coverSrc = flags.required("cover-src");
    const coverAlt = flags.required("cover-alt");

    const digest = /^\/media\/([0-9a-f]{64})\//u.exec(coverSrc)?.[1];
    if (digest === undefined) {
      throw new ValidationError(
        `--cover-src must be /media/<64-character source sha256>/1600.webp, but is ${JSON.stringify(coverSrc)}.`,
      );
    }

    const record = await readMediaRecord(MEDIA_WORKSPACE_DIR, digest);
    if (record === null) {
      throw new ValidationError(
        `No local media record exists for ${digest}. Run media:add on the source image first; a cover cannot be written from a guess.`,
      );
    }

    const expected = variantPath(digest, 1600, "webp");
    if (coverSrc !== expected) {
      throw new ValidationError(
        `A cover must be ${expected} (the 1600×900 WebP derivative), but ${coverSrc} was given.`,
      );
    }
    const cover = record.variants.find(
      (variant) => variant.width === 1600 && variant.format === "webp",
    );
    if (cover === undefined || cover.height !== 900) {
      throw new ValidationError(
        `The media record for ${digest} has no 1600×900 WebP derivative, so it cannot be a cover. Regenerate it with media:add --cover.`,
      );
    }

    frontmatter = {
      title,
      description,
      publishedAt,
      draft: true,
      ...(tags.length === 0 ? {} : { tags }),
      ...(seriesFlag === undefined ? {} : { series: parseSeries(seriesFlag) }),
      cover: {
        src: coverSrc,
        alt: coverAlt,
        width: 1600,
        height: 900,
        ...(credit === undefined ? {} : { credit }),
      },
    };
  } else if (kind === "page") {
    frontmatter = { title, description, draft: true };
  } else {
    const order = flags.number("order");
    frontmatter = {
      title,
      description,
      draft: true,
      ...(order === undefined ? {} : { order }),
    };
  }

  const schema =
    kind === "post" ? postSchema : kind === "page" ? pageSchema : indexSchema;
  const result = schema.safeParse(frontmatter);
  if (!result.success) {
    throw new ValidationError(
      "The values given do not satisfy the content schema.",
      {
        issues: result.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      },
    );
  }

  await writeFileAtomic(absolutePath, renderDocument(frontmatter, body));
  reporter.action("write", relativePath, {
    detail: `new ${kind}, draft: true`,
  });
  reporter.setSummary(
    `Created ${relativePath} as a draft. Edit it, then publish when it is ready.`,
  );
  return EXIT.OK;
}

export async function runNew(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(newDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runNew(process.argv.slice(2));
}
