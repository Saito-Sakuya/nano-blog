import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatFlagHelp,
  GLOBAL_FLAGS,
  parseArgs,
  type FlagSpec,
  type Flags,
} from "./args.js";
import {
  resolveDependencies,
  type CommandDependencies,
  type ResolvedDependencies,
} from "./deps.js";
import { EXIT, toCliError, UsageError, type ExitCode } from "./errors.js";
import type { Environment } from "./env.js";
import { Reporter } from "./reporter.js";

/**
 * The command runner.
 *
 * Every entry point builds a `CliDefinition` and hands it to `runCli`, which
 * owns the parts that must behave identically everywhere: `--help`, the
 * `--apply`/`--dry-run` switch, the exit code, and the guarantee that in
 * `--json` mode stdout contains exactly one JSON object.
 */

export interface CliContext {
  readonly command: string;
  readonly argv: readonly string[];
  readonly flags: Flags;
  readonly positionals: readonly string[];
  readonly reporter: Reporter;
  readonly env: Environment;
  readonly dependencies: ResolvedDependencies;
  readonly json: boolean;
  /** True only when `--apply` was given. */
  readonly apply: boolean;
  /** True unless `--apply` was given. */
  readonly dryRun: boolean;
}

export interface CliDefinition {
  /** Script name as `package.json` exposes it, e.g. `content:publish`. */
  readonly command: string;
  readonly summary: string;
  /** One or more usage lines, without the leading `pnpm`. */
  readonly usage: readonly string[];
  readonly flags: readonly FlagSpec[];
  /** Extra prose shown under the flag table. */
  readonly notes?: readonly string[];
  readonly handler: (context: CliContext) => Promise<ExitCode>;
}

export function renderHelp(definition: CliDefinition): string {
  const lines: string[] = [
    `${definition.command} — ${definition.summary}`,
    "",
    "Usage:",
    ...definition.usage.map((line) => `  pnpm ${line}`),
    "",
    "Flags:",
    formatFlagHelp([...definition.flags, ...GLOBAL_FLAGS]),
  ];

  if (definition.notes !== undefined && definition.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of definition.notes) lines.push(`  ${note}`);
  }

  return `${lines.join("\n")}\n`;
}

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * True when this module is the process entry point.
 *
 * `process.argv[1]` is compared with the module's own URL rather than using
 * `require.main`, which does not exist in ESM. Windows drive-letter casing is
 * folded, because `D:\` and `d:\` are the same file.
 */
export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;

  try {
    const fromModule = path.resolve(fileURLToPath(metaUrl));
    const fromArgv = path.resolve(entry);
    return process.platform === "win32"
      ? fromModule.toLowerCase() === fromArgv.toLowerCase()
      : fromModule === fromArgv;
  } catch {
    return false;
  }
}

export async function runCli(
  definition: CliDefinition,
  argv: readonly string[] = process.argv.slice(2),
  overrides: CommandDependencies = {},
): Promise<ExitCode> {
  if (wantsHelp(argv)) {
    // Help is answered before any dependency is resolved, so asking a command
    // what it does never loads the image pipeline, opens a bucket, or needs a
    // credential.
    const write =
      overrides.stdout ?? ((text: string) => process.stdout.write(text));
    write(renderHelp(definition));
    return EXIT.OK;
  }

  const dependencies = await resolveDependencies(overrides);

  const output = {
    command: definition.command,
    json: argv.includes("--json"),
    env: dependencies.env,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
  };

  // Until `--apply` has been read, assume the safe reading of the command line;
  // this instance only ever reports a parse failure.
  let reporter = new Reporter({ ...output, dryRun: !argv.includes("--apply") });

  try {
    const { flags, positionals } = parseArgs(argv, [
      ...definition.flags,
      ...GLOBAL_FLAGS,
    ]);

    for (const warning of dependencies.env.warnings) {
      reporter.note(`warning: ${warning}`);
    }

    const apply = flags.boolean("apply");
    const forceDryRun = flags.boolean("dry-run");

    if (apply && forceDryRun) {
      throw new UsageError(
        "--apply and --dry-run contradict each other; give exactly one.",
      );
    }

    const dryRun = !apply;
    reporter = new Reporter({ ...output, dryRun });

    const context: CliContext = {
      command: definition.command,
      argv: [...argv],
      flags,
      positionals,
      reporter,
      env: dependencies.env,
      dependencies,
      json: reporter.json,
      apply,
      dryRun,
    };

    const code = await definition.handler(context);
    return context.reporter.finish(code);
  } catch (error) {
    const cliError = toCliError(error);
    reporter.error(cliError);
    if (reporter.summary.length === 0) reporter.setSummary(cliError.message);
    return reporter.finish(cliError.code);
  }
}

/** Run a command as the process entry point and set the exit code. */
export async function runEntry(
  definition: CliDefinition,
  argv: readonly string[] = process.argv.slice(2),
  overrides: CommandDependencies = {},
): Promise<void> {
  process.exitCode = await runCli(definition, argv, overrides);
}
