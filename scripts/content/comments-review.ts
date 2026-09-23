import "../lib/env.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import { EXIT, UsageError, type ExitCode } from "../lib/errors.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import type { CommentStatus } from "../../src/lib/comments/rules.js";
import {
  createReviewClient,
  readReviewCredentials,
  type CommentRecord,
  type ReviewClient,
} from "./comments-d1.js";

/**
 * `comments:review` — read the moderation queue and decide on entries.
 *
 * Comments are stored `pending` and are invisible on the site until they are
 * approved here. This is the only way they become visible, which is what makes
 * "pre-moderated" a property of the system rather than a setting.
 *
 * Follows the same shape as every other content command: **a dry run by
 * default**, `--apply` to write, `--json` for a machine-readable envelope, and
 * one of the fixed exit codes. Listing needs no `--apply` because it changes
 * nothing; a decision without `--apply` prints what it would do.
 *
 * The rendered Markdown is shown as well as the source, because reviewing means
 * reading what a reader would see — a link whose destination was stripped looks
 * like a link until you read the HTML.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "approve",
    kind: "string",
    value: "<id>",
    summary: "Approve one comment by id, so it becomes visible on the site.",
  },
  {
    name: "reject",
    kind: "string",
    value: "<id>",
    summary: "Reject one comment. It stays stored but is never shown.",
  },
  {
    name: "status",
    kind: "string",
    value: "<state>",
    choices: ["pending", "approved", "rejected", "any"],
    summary: "Which queue to list; defaults to pending.",
  },
  {
    name: "limit",
    kind: "string",
    value: "<n>",
    summary: "Most entries to list; defaults to 50.",
  },
];

export const commentsReviewDefinition: CliDefinition = {
  command: "comments:review",
  summary: "Review submitted comments and approve or reject them.",
  usage: [
    "comments:review [--status pending|approved|rejected|any] [--limit <n>] [--json]",
    "comments:review --approve <id> [--apply]",
    "comments:review --reject <id> [--apply]",
  ],
  flags: FLAGS,
  notes: [
    "Comment bodies are shown as Markdown and as rendered HTML, because review means reading what a reader would see.",
    "Decisions are a dry run unless --apply is given.",
    "Requires CF_D1_API_TOKEN with D1 edit permission plus R2_ACCOUNT_ID and CF_D1_DATABASE_ID.",
    "A comment is only ever displayed in the approved state; pending and rejected are invisible on the site.",
  ],
  handler: handleReview,
};

/** Most comments shown when no limit is given. */
const DEFAULT_LIMIT = 50;

/** The largest page this command will fetch. */
const MAX_LIMIT = 500;

function parseLimit(context: CliContext): number {
  const raw = context.flags.string("limit");
  if (raw === undefined) return DEFAULT_LIMIT;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new UsageError(
      `--limit must be a whole number between 1 and ${String(MAX_LIMIT)}.`,
    );
  }
  return value;
}

function parseStatus(context: CliContext): CommentStatus | "any" {
  const raw = context.flags.string("status");
  if (raw === undefined) return "pending";
  return raw as CommentStatus | "any";
}

/** One line describing a comment, for the summary and the JSON envelope. */
function describe(comment: CommentRecord): string {
  const firstLine =
    comment.bodyMarkdown.split("\n").find((line) => line.trim().length > 0) ??
    "";
  const preview =
    firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return `${comment.authorName} · ${comment.postId} · ${preview}`;
}

/** Print one comment in full, for a person to read before deciding. */
function showComment(context: CliContext, comment: CommentRecord): void {
  const { reporter } = context;
  reporter.heading(
    `${comment.authorName} — ${comment.postId} — ${comment.createdAt}`,
  );
  reporter.note(`  id      : ${comment.id}`);
  reporter.note(`  status  : ${comment.status}`);
  reporter.note(`  avatar  : /avatar/${comment.emailHash}`);
  reporter.note("  markdown:");
  for (const line of comment.bodyMarkdown.split("\n")) {
    reporter.note(`    ${line}`);
  }
  reporter.note("  rendered:");
  reporter.note(`    ${comment.bodyHtml}`);
}

async function handleReview(context: CliContext): Promise<ExitCode> {
  const { reporter, flags } = context;
  const limit = parseLimit(context);
  const status = parseStatus(context);

  const approve = flags.string("approve");
  const reject = flags.string("reject");

  if (approve !== undefined && reject !== undefined) {
    throw new UsageError("Pass either --approve or --reject, not both.");
  }

  const credentials = readReviewCredentials(context.env);
  const client: ReviewClient = createReviewClient(
    credentials,
    context.dependencies.fetch,
  );

  // --- a decision ----------------------------------------------------------

  const deciding =
    approve !== undefined
      ? { id: approve, next: "approved" as const }
      : reject !== undefined
        ? { id: reject, next: "rejected" as const }
        : null;

  if (deciding !== null) {
    // Find it first, so the reviewer sees what they are about to publish and a
    // mistyped id fails before anything is written.
    const candidates = await client.list("any", MAX_LIMIT);
    const target = candidates.find((comment) => comment.id === deciding.id);

    if (target === undefined) {
      reporter.error(
        new Error(
          `No comment with id ${deciding.id}. Run \`pnpm comments:review --status any\` to see the ids.`,
        ),
      );
      return EXIT.VALIDATION;
    }

    if (target.status === deciding.next) {
      reporter.action("noop", deciding.id, {
        detail: `already ${deciding.next}`,
      });
      reporter.setSummary(
        `Comment ${deciding.id} is already ${deciding.next}.`,
      );
      return EXIT.OK;
    }

    showComment(context, target);
    reporter.action("write", deciding.id, {
      detail: `${target.status} → ${deciding.next}`,
    });

    if (!context.apply) {
      reporter.setSummary(
        `Dry run: would mark ${deciding.id} as ${deciding.next}. Re-run with --apply to write it.`,
      );
      return EXIT.OK;
    }

    const changed = await client.setStatus(deciding.id, deciding.next);
    if (!changed) {
      // The row was there a moment ago and the update matched nothing: either it
      // was removed between the two statements, or the id no longer identifies
      // the same row. Either way the caller should look again.
      reporter.error(
        new Error(
          `The update matched no row for ${deciding.id}; the comment may have been removed. Nothing was changed.`,
        ),
      );
      return EXIT.REMOTE;
    }

    reporter.setSummary(
      deciding.next === "approved"
        ? `Approved ${deciding.id}. It is now visible on ${target.postId}.`
        : `Rejected ${deciding.id}. It stays stored and is not shown.`,
    );
    return EXIT.OK;
  }

  // --- listing -------------------------------------------------------------

  const comments = await client.list(status, limit);

  if (comments.length === 0) {
    reporter.setSummary(
      status === "pending"
        ? "No comments waiting for review."
        : `No comments with status ${status}.`,
    );
    return EXIT.OK;
  }

  for (const comment of comments) {
    if (status === "pending") {
      showComment(context, comment);
    } else {
      // A settled queue is a list, not something to read through in full.
      reporter.action("verify", comment.id, {
        detail: `${comment.status} · ${describe(comment)}`,
      });
    }
  }

  const pending = await client.countByStatus("pending");
  reporter.setSummary(
    status === "pending"
      ? `${String(comments.length)} comment(s) waiting for review. Approve with \`pnpm comments:review --approve <id> --apply\`.`
      : `${String(comments.length)} comment(s) with status ${status}; ${String(pending)} still pending.`,
  );

  return EXIT.OK;
}

export async function runCommentsReview(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(commentsReviewDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runCommentsReview(process.argv.slice(2));
}
