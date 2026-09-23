import { readFileSync } from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { CredentialsError } from "./errors.js";
import {
  describeSecret,
  describeVariable,
  redactSecretsIn,
  SECRET_ENVIRONMENT_NAMES,
} from "./redact.js";

/**
 * Environment and `.env` handling.
 *
 * Importing this module loads `.env` once, before anything else looks at the
 * environment — the same idiom as `import 'dotenv/config'`. Every entry point
 * imports it first, so a value that lives only in `.env` is present by the time
 * `src/lib/site.ts` reads it at module scope.
 *
 * Real environment variables always win over the file: CI and Cloudflare Pages
 * set their own values, and a stale `.env` on disk must never override them.
 */

const DEFAULT_ENV_PATH = path.join(PROJECT_ROOT, ".env");

export interface DotEnvFile {
  readonly path: string;
  readonly exists: boolean;
  readonly values: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

interface BootState {
  readonly file: DotEnvFile;
  readonly applied: readonly string[];
}

let bootState: BootState | undefined;

/**
 * Parse the `KEY=value` format used by `.env` files.
 *
 * Supports `export KEY=value`, single- and double-quoted values (with `\n`,
 * `\r`, `\t`, `\"` and `\\` escapes inside double quotes), an unquoted trailing
 * comment, and ignores blank lines and `#` comments. A quoted value ends at its
 * closing quote, so a comment after it is a comment and not part of the value.
 * A line that looks like it wanted to be an assignment but has no `=` is
 * recorded as a warning instead of being silently dropped.
 */
export function parseDotEnv(
  text: string,
  sourceLabel: string,
): {
  values: Map<string, string>;
  warnings: string[];
} {
  const values = new Map<string, string>();
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/u);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = withoutExport.indexOf("=");

    if (separator === -1) {
      warnings.push(
        `${sourceLabel}:${index + 1} is not a KEY=value assignment and was ignored.`,
      );
      continue;
    }

    const name = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      warnings.push(
        `${sourceLabel}:${index + 1} has an invalid variable name and was ignored.`,
      );
      continue;
    }

    const rawValue = withoutExport.slice(separator + 1).trim();
    values.set(name, parseDotEnvValue(rawValue));
  }

  return { values, warnings };
}

/**
 * Parse the value half of a `KEY=value` line.
 *
 * Quoted values end at the first *unescaped* closing quote, not at the last one
 * in the line: `KEY="v" # don't change` is the value `v` plus a comment, and
 * searching for the last quote turned the comment into part of the value. A
 * single-quoted value has no escapes; a double-quoted one supports `\n`, `\r`,
 * `\t`, `\"` and `\\`. An unquoted value ends at the first ` #`.
 *
 * Anything after the closing quote is ignored, because the only well-formed
 * thing that can appear there is a comment.
 */
function parseDotEnvValue(rawValue: string): string {
  const quote = rawValue[0];

  if (quote === '"' || quote === "'") {
    const end = closingQuoteIndex(rawValue, quote);
    if (end === -1) {
      // Unterminated: take the rest of the line, as dotenv does when a value
      // merely starts with a quote character.
      return rawValue.slice(1);
    }
    const inner = rawValue.slice(1, end);
    return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
  }

  // An unquoted value ends at the first ` #`; everything else is literal.
  const comment = /\s#/u.exec(rawValue);
  return comment === null
    ? rawValue
    : rawValue.slice(0, comment.index).trimEnd();
}

/**
 * The index of the quote that closes a quoted value, or `-1`.
 *
 * A backslash escapes the next character inside double quotes, so `"a\"b"`
 * closes at the fourth quote rather than the first.
 */
function closingQuoteIndex(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/** The escape sequences a double-quoted `.env` value understands. */
const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
};

/**
 * Resolve the escapes of a double-quoted value in one pass.
 *
 * Sequential `replace` calls cannot do this correctly: `\\n` is an escaped
 * backslash followed by an `n`, and a first pass that turned `\n` into a
 * newline would leave a lone backslash and a newline instead.
 */
function unescapeDoubleQuoted(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      result += char;
      break;
    }

    // An escape with no meaning is kept verbatim, so a Windows path written
    // with single backslashes survives untouched.
    result += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
    index += 1;
  }

  return result;
}

export interface BootOptions {
  readonly envPath?: string;
  /** Load the file even when the variable is already set in the environment. */
  readonly override?: boolean;
  readonly target?: NodeJS.ProcessEnv;
}

/**
 * Load `.env` into `process.env`. Idempotent: the first call wins, so a test
 * can call it again without disturbing a deliberately prepared environment.
 */
export function bootEnv(options: BootOptions = {}): BootState {
  if (bootState !== undefined) return bootState;

  const envPath = options.envPath ?? DEFAULT_ENV_PATH;
  const target = options.target ?? process.env;
  const file = readDotEnvFile(envPath);
  const applied: string[] = [];

  for (const [name, value] of file.values) {
    const existing = target[name];
    if (options.override !== true && existing !== undefined && existing !== "")
      continue;
    target[name] = value;
    applied.push(name);
  }

  bootState = { file, applied };
  return bootState;
}

function readDotEnvFile(envPath: string): DotEnvFile {
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path: envPath, exists: false, values: new Map(), warnings: [] };
    }
    throw new CredentialsError(
      `Could not read ${envPath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  const { values, warnings } = parseDotEnv(text, path.basename(envPath));
  return { path: envPath, exists: true, values, warnings };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Test-only: forget the memoised boot so a different file can be loaded. */
export function resetEnvBoot(): void {
  bootState = undefined;
}

/**
 * A read-only view of the environment with the project's own lookup rules.
 *
 * An empty string means "not set". `.env.example` ships every secret as an
 * empty value on purpose, and a copy of it must fail with exit code 4 rather
 * than reaching R2 with an empty key.
 */
export class Environment {
  readonly #source: NodeJS.ProcessEnv;
  readonly #warnings: readonly string[];

  constructor(
    source: NodeJS.ProcessEnv = process.env,
    warnings: readonly string[] = [],
  ) {
    this.#source = source;
    this.#warnings = warnings;
  }

  get warnings(): readonly string[] {
    return [...this.#warnings];
  }

  get(name: string): string | undefined {
    const value = this.#source[name];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** A non-secret identifier with a documented default. */
  withDefault(name: string, fallback: string): string {
    return this.get(name) ?? fallback;
  }

  require(name: string, purpose: string): string {
    const value = this.get(name);
    if (value === undefined) {
      throw new CredentialsError(
        `${name} is required to ${purpose}. Set it in .env (see .env.example); it is currently ${describeSecret(undefined)}.`,
      );
    }
    return value;
  }

  /**
   * The first of several acceptable variables. The three R2 credential groups
   * are named separately on purpose, but a read-only command may legitimately
   * fall back from author credentials to build credentials.
   */
  requireOneOf(
    names: readonly string[],
    purpose: string,
  ): { name: string; value: string } {
    for (const name of names) {
      const value = this.get(name);
      if (value !== undefined) return { name, value };
    }
    throw new CredentialsError(
      `One of ${names.join(", ")} is required to ${purpose}. Set it in .env (see .env.example).`,
    );
  }

  /** `set (redacted)` / `unset` for secrets, the value itself otherwise. */
  describe(name: string): string {
    return describeVariable(name, this.get(name));
  }

  /** Every secret value currently present, for log redaction. */
  secretValues(): readonly string[] {
    const values: string[] = [];
    for (const name of SECRET_ENVIRONMENT_NAMES) {
      const value = this.get(name);
      if (value !== undefined) values.push(value);
    }
    return values;
  }

  /** Replace any known secret value in `text`. */
  redact(text: string): string {
    return redactSecretsIn(text, this.secretValues());
  }
}

/** The process environment, with `.env` already loaded by this module. */
export function currentEnvironment(): Environment {
  return new Environment(process.env, bootState?.file.warnings ?? []);
}

// Loading `.env` is the reason this module exists; see the note at the top.
bootEnv();
