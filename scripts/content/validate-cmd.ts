import "../lib/env.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import type { CommandDependencies } from "../lib/deps.js";
import { EXIT, ValidationError, type ExitCode } from "../lib/errors.js";
import type { FlagSpec } from "../lib/args.js";
import {
  loadContentSource,
  resolveLocalSource,
  type ContentSourceKind,
} from "./load.js";
import { checkRedirectTable, validateSource } from "./validate.js";

/**
 * `content:validate` — check a content source without touching anything.
 *
 * Everything the release pipeline enforces is checked here first, so an author
 * finds out about a broken link or a duplicate route while the file is still on
 * their own disk. The command is entirely local: no credentials, no network,
 * and no writes.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "source",
    kind: "string",
    value: "<kind>",
    choices: ["workspace", "runtime", "fixtures", "directory"],
    summary:
      "Which content source to read; defaults to the workspace, then the runtime.",
  },
  {
    name: "path",
    kind: "string",
    value: "<dir>",
    summary: "Read a specific directory instead of the default source.",
  },
  {
    name: "publication",
    kind: "boolean",
    summary:
      "Check exactly what publishing would: public entries must be complete and their media resolvable.",
  },
];

export const validateDefinition: CliDefinition = {
  command: "content:validate",
  summary:
    "Validate content schema, paths, routes, links, media, dates, tags, series and licence.",
  usage: [
    "content:validate [--source workspace|runtime|fixtures|directory] [--path <dir>] [--publication] [--json]",
  ],
  flags: FLAGS,
  notes: [
    "Exits 0 when there are no errors (warnings are allowed) and 3 when validation fails.",
    "Never contacts R2 and never writes to disk.",
  ],
  handler: handleValidate,
};

async function handleValidate(context: CliContext): Promise<ExitCode> {
  const { reporter, flags } = context;

  const explicitKind = flags.string("source") as ContentSourceKind | undefined;
  const explicitPath = flags.string("path");

  const resolved = await resolveLocalSource({
    ...(explicitKind === undefined ? {} : { kind: explicitKind }),
    ...(explicitPath === undefined ? {} : { root: explicitPath }),
  });

  reporter.note(`source: ${resolved.label} (${resolved.root})`);

  const source = await loadContentSource({
    root: resolved.root,
    kind: resolved.kind,
  });
  const report = validateSource({
    source,
    now: context.dependencies.now(),
    publication: flags.boolean("publication"),
    strictMedia: flags.boolean("publication"),
  });

  // The redirect table is checked here rather than inside `validateSource`,
  // because it is a second file and a property of the site rather than of the
  // source being validated. Its issues join the same report so one run shows
  // every problem an author has to fix.
  const issues = [...report.issues, ...(await checkRedirectTable(source))];

  for (const issue of issues) {
    reporter.action("verify", issue.file ?? resolved.label, {
      detail: `${issue.severity}${issue.field === undefined ? "" : ` ${issue.field}`}: ${issue.message}`,
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;

  reporter.setSummary(
    `${report.entryCount} file(s): ${report.publicPosts} public post(s), ${report.publicPages} public page(s); ${errors} error(s), ${warnings} warning(s).`,
  );

  if (errors > 0) {
    reporter.error(
      new ValidationError(`Validation failed with ${errors} error(s).`, {
        issues: issues
          .filter((issue) => issue.severity === "error")
          .map(
            (issue) =>
              `${issue.file ?? "(unknown)"}${issue.field === undefined ? "" : ` [${issue.field}]`}: ${issue.message}`,
          ),
      }),
    );
    return EXIT.VALIDATION;
  }

  return EXIT.OK;
}

export async function runValidate(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(validateDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runValidate(process.argv.slice(2));
}
