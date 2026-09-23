import { UsageError } from "./errors.js";

/**
 * A small, strict argument parser.
 *
 * It is deliberately not a lenient one. An unknown flag is an error rather than
 * something ignored, a flag that needs a value always gets one from the same
 * token or the next, and `--` hands the rest of the line to the command. A
 * typo in `--apply` must never look like a successful dry run.
 *
 * The parser is pure: it takes `argv` and flag specifications and returns flag
 * values plus positionals, with no process state involved, so it is directly
 * unit-testable.
 */

export type FlagKind = "boolean" | "string" | "number";

export interface FlagSpec {
  /** Long name without the leading dashes, e.g. `apply`. */
  readonly name: string;
  readonly kind: FlagKind;
  readonly summary: string;
  /** Value placeholder for the help table, e.g. `<path>`. */
  readonly value?: string;
  /** May be given more than once; values accumulate in order. */
  readonly repeatable?: boolean;
  /** When present, the value must be one of these. */
  readonly choices?: readonly string[];
}

export const APPLY_FLAG: FlagSpec = {
  name: "apply",
  kind: "boolean",
  summary: "Perform the remote changes. Without it the command is a dry run.",
};

export const DRY_RUN_FLAG: FlagSpec = {
  name: "dry-run",
  kind: "boolean",
  summary: "Force a dry run; refuses to combine with --apply.",
};

export const JSON_FLAG: FlagSpec = {
  name: "json",
  kind: "boolean",
  summary: "Write the machine-readable envelope to stdout and nothing else.",
};

export const HELP_FLAG: FlagSpec = {
  name: "help",
  kind: "boolean",
  summary: "Show this help.",
};

/** Flags every command accepts. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  APPLY_FLAG,
  DRY_RUN_FLAG,
  JSON_FLAG,
  HELP_FLAG,
];

/** Flag values, addressed by name. */
export class Flags {
  readonly #values: ReadonlyMap<string, string | boolean | readonly string[]>;

  constructor(
    values: ReadonlyMap<string, string | boolean | readonly string[]>,
  ) {
    this.#values = values;
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  /** True only when the boolean flag was given. */
  boolean(name: string): boolean {
    const value = this.#values.get(name);
    if (value === undefined) return false;
    if (typeof value !== "boolean") {
      throw new UsageError(`--${name} is not a boolean flag.`);
    }
    return value;
  }

  string(name: string): string | undefined {
    const value = this.#values.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new UsageError(`--${name} does not take a single string value.`);
    }
    return value;
  }

  /** A required string flag; missing means the command cannot run at all. */
  required(name: string): string {
    const value = this.string(name);
    if (value === undefined) {
      throw new UsageError(`--${name} is required.`);
    }
    return value;
  }

  number(name: string): number | undefined {
    const value = this.#values.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new UsageError(`--${name} expects a numeric value.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new UsageError(
        `--${name} expects a number, but received ${JSON.stringify(value)}.`,
      );
    }
    return parsed;
  }

  /** Every value given for a repeatable flag, in order. */
  list(name: string): readonly string[] {
    const value = this.#values.get(name);
    if (value === undefined) return [];
    if (typeof value === "string") return [value];
    if (typeof value === "boolean") {
      throw new UsageError(
        `--${name} is a boolean flag and cannot be repeated.`,
      );
    }
    return value;
  }
}

export interface ParsedArgs {
  readonly flags: Flags;
  readonly positionals: readonly string[];
}

function specIndex(specs: readonly FlagSpec[]): Map<string, FlagSpec> {
  const index = new Map<string, FlagSpec>();
  for (const spec of specs) {
    if (index.has(spec.name)) {
      throw new Error(`Duplicate flag specification for --${spec.name}.`);
    }
    index.set(spec.name, spec);
  }
  return index;
}

function looksLikeFlag(token: string): boolean {
  return token.length > 1 && token.startsWith("-");
}

/**
 * Parse `argv` against `specs`.
 *
 * Accepted forms: `--flag`, `--flag value`, `--flag=value`, `-h`, and `--`
 * followed by positionals. A value that itself starts with `--` is never
 * consumed as a value, so a mistyped `--release --apply` fails instead of
 * silently treating `--apply` as a release id.
 */
export function parseArgs(
  argv: readonly string[],
  specs: readonly FlagSpec[],
): ParsedArgs {
  const index = specIndex(specs);
  const values = new Map<string, string | boolean | readonly string[]>();
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let position = 0; position < argv.length; position += 1) {
    const token = argv[position];
    if (token === undefined) continue;

    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      onlyPositionals = true;
      continue;
    }

    if (token === "-h") {
      values.set("help", true);
      continue;
    }

    if (!looksLikeFlag(token)) {
      positionals.push(token);
      continue;
    }

    if (!token.startsWith("--")) {
      throw new UsageError(
        `Unknown flag ${JSON.stringify(token)}. Use --help for the full list.`,
      );
    }

    const separator = token.indexOf("=");
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const inlineValue =
      separator === -1 ? undefined : token.slice(separator + 1);
    const spec = index.get(name);

    if (spec === undefined) {
      throw new UsageError(
        `Unknown flag --${name}. Use --help for the full list.`,
      );
    }

    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      if (spec.repeatable === true) {
        const previous = values.get(name);
        const list =
          previous === undefined
            ? []
            : Array.isArray(previous)
              ? [...previous]
              : [];
        values.set(name, list);
        list.push("true");
        continue;
      }
      values.set(name, true);
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[position + 1];
      if (next === undefined || looksLikeFlag(next)) {
        throw new UsageError(`--${name} needs a value.`);
      }
      raw = next;
      position += 1;
    }

    if (spec.kind === "number" && !Number.isFinite(Number(raw))) {
      throw new UsageError(
        `--${name} expects a number, but received ${JSON.stringify(raw)}.`,
      );
    }

    if (spec.choices !== undefined && !spec.choices.includes(raw)) {
      throw new UsageError(
        `--${name} must be one of ${spec.choices.map((choice) => JSON.stringify(choice)).join(", ")}, but received ${JSON.stringify(raw)}.`,
      );
    }

    if (spec.repeatable === true) {
      const previous = values.get(name);
      const list =
        previous === undefined
          ? []
          : Array.isArray(previous)
            ? [...previous]
            : [];
      values.set(name, list);
      list.push(raw);
      continue;
    }

    if (values.has(name)) {
      // Two values for one flag is ambiguous, and silently keeping the last
      // one would mean acting on something the caller did not write.
      throw new UsageError(`--${name} was given more than once.`);
    }

    values.set(name, raw);
  }

  return { flags: new Flags(values), positionals };
}

/** Render the flag table used by `--help`. */
export function formatFlagHelp(specs: readonly FlagSpec[]): string {
  const rows = specs.map((spec) => {
    const value = spec.kind === "boolean" ? "" : ` ${spec.value ?? "<value>"}`;
    const repeat = spec.repeatable === true ? " (repeatable)" : "";
    const choices =
      spec.choices === undefined ? "" : ` One of: ${spec.choices.join(", ")}.`;
    return {
      left: `  --${spec.name}${value}${repeat}`,
      right: `${spec.summary}${choices}`,
    };
  });

  const width =
    rows.reduce((max, row) => Math.max(max, row.left.length), 0) + 2;
  return rows.map((row) => `${row.left.padEnd(width)}${row.right}`).join("\n");
}
