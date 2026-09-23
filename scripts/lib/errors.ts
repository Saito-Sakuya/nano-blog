/**
 * Exit codes and the error types that carry them.
 *
 * Seven exit codes are fixed. Every failure path in the author
 * tooling raises one of the classes below, so the code a caller sees is decided
 * where the failure is understood rather than sniffed out of a message later:
 *
 * | Code | Meaning                                                   |
 * | ---- | --------------------------------------------------------- |
 * | 0    | Success, or a successful no-op                            |
 * | 2    | Bad arguments                                             |
 * | 3    | Content or manifest validation failure                    |
 * | 4    | Missing credentials or required environment               |
 * | 5    | Network or Cloudflare service failure                     |
 * | 6    | `active.json` concurrency conflict                        |
 * | 7    | Cleanup plan is stale                                     |
 */

export const EXIT = {
  OK: 0,
  USAGE: 2,
  VALIDATION: 3,
  CREDENTIALS: 4,
  REMOTE: 5,
  CONFLICT: 6,
  STALE_PLAN: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The set of codes a command may legitimately finish with. */
export const EXIT_CODES: readonly ExitCode[] = [0, 2, 3, 4, 5, 6, 7];

export function isExitCode(value: number): value is ExitCode {
  return (EXIT_CODES as readonly number[]).includes(value);
}

export interface CliErrorOptions {
  readonly code?: ExitCode;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

/**
 * Base class for every failure the CLI reports deliberately.
 *
 * `issues` are the per-item explanations — one per offending file, field or
 * object — that a machine-readable caller reads instead of parsing prose.
 */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly issues: readonly string[];

  constructor(message: string, options: CliErrorOptions = {}) {
    super(
      message,
      options.cause === undefined
        ? undefined
        : {
            cause: options.cause,
          },
    );
    this.name = "CliError";
    this.code = options.code ?? EXIT.VALIDATION;
    this.issues = options.issues ?? [];
  }
}

/** Bad arguments: unknown flag, missing value, contradictory options. */
export class UsageError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.USAGE });
    this.name = "UsageError";
  }
}

/** Content, manifest or plan validation failure. */
export class ValidationError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.VALIDATION });
    this.name = "ValidationError";
  }
}

/** A required credential or environment variable is absent. */
export class CredentialsError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.CREDENTIALS });
    this.name = "CredentialsError";
  }
}

/** Network, Cloudflare or any other remote service failure. */
export class RemoteError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.REMOTE });
    this.name = "RemoteError";
  }
}

/** A compare-and-swap precondition failed: someone else moved the pointer. */
export class ConflictError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.CONFLICT });
    this.name = "ConflictError";
  }
}

/** The cleanup plan a caller supplied no longer describes the remote state. */
export class StalePlanError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, "code"> = {}) {
    super(message, { ...options, code: EXIT.STALE_PLAN });
    this.name = "StalePlanError";
  }
}

/**
 * Wrap an error from a shared helper as a validation failure.
 *
 * `parseContentPath` and `parseCodeFence` raise their own error types, which
 * are plain `Error`s. Letting one reach the top level would report a mistyped
 * path as a network failure (exit 5), so call sites convert them where the
 * meaning is known.
 */
export function toValidationError(
  error: unknown,
  statement?: string,
): ValidationError {
  if (error instanceof CliError)
    return new ValidationError(error.message, {
      issues: error.issues,
      cause: error,
    });
  const message = error instanceof Error ? error.message : String(error);
  return new ValidationError(
    statement === undefined ? message : `${statement}: ${message}`,
    {
      cause: error,
    },
  );
}

/**
 * Normalise anything thrown into a `CliError`.
 *
 * An error that already carries a code keeps it; anything else is an
 * unexpected failure and is reported as a remote/service failure, which is the
 * only code that means "something went wrong that is not the author's content".
 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  if (error instanceof Error) {
    return new CliError(error.message, { code: EXIT.REMOTE, cause: error });
  }

  return new CliError(String(error), { code: EXIT.REMOTE, cause: error });
}
