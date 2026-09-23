import {
  buildEnvelope,
  stringifyEnvelope,
  type ActionKind,
  type Envelope,
  type EnvelopeAction,
  type EnvelopeError,
} from "./envelope.js";
import { toCliError, type ExitCode } from "./errors.js";
import type { Environment } from "./env.js";

/**
 * Output for one command run.
 *
 * The reporter is the only thing that writes to stdout. In `--json` mode it
 * writes nothing until the run finishes, then writes exactly one JSON envelope;
 * diagnostics that a human would want to see go to stderr instead, so a piped
 * stdout stays parseable. In human mode the same information is printed as it
 * happens, which is what makes a dry run readable.
 *
 * Every line passes through the environment's redaction, so a credential that
 * a caller accidentally interpolates into a message is replaced before it is
 * ever written.
 */

export interface ReporterOptions {
  readonly command: string;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly env: Environment;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export class Reporter {
  readonly command: string;
  readonly json: boolean;
  readonly dryRun: boolean;

  readonly #env: Environment;
  readonly #stdout: (text: string) => void;
  readonly #stderr: (text: string) => void;
  readonly #actions: EnvelopeAction[] = [];
  readonly #errors: EnvelopeError[] = [];
  #summary = "";
  #finished = false;

  constructor(options: ReporterOptions) {
    this.command = options.command;
    this.json = options.json;
    this.dryRun = options.dryRun;
    this.#env = options.env;
    this.#stdout = options.stdout ?? ((text) => process.stdout.write(text));
    this.#stderr = options.stderr ?? ((text) => process.stderr.write(text));
  }

  get actions(): readonly EnvelopeAction[] {
    return this.#actions;
  }

  get errors(): readonly EnvelopeError[] {
    return this.#errors;
  }

  get summary(): string {
    return this.#summary;
  }

  /** Record something the command did, or would do under `--apply`. */
  action(
    kind: ActionKind,
    target: string,
    options: { detail?: string; bytes?: number } = {},
  ): void {
    const safeTarget = this.#env.redact(target);
    const detail =
      options.detail === undefined
        ? undefined
        : this.#env.redact(options.detail);

    const action: EnvelopeAction =
      options.bytes === undefined
        ? detail === undefined
          ? { kind, target: safeTarget }
          : { kind, target: safeTarget, detail }
        : detail === undefined
          ? { kind, target: safeTarget, bytes: options.bytes }
          : { kind, target: safeTarget, detail, bytes: options.bytes };

    this.#actions.push(action);

    if (!this.json) {
      const size = options.bytes === undefined ? "" : ` (${options.bytes} B)`;
      const note = detail === undefined ? "" : ` — ${detail}`;
      this.#stdout(`${kind.padEnd(9)}${safeTarget}${size}${note}\n`);
    }
  }

  /** Convenience for the shape most callers want. */
  plan(target: string, detail?: string, bytes?: number): void {
    this.action("plan", target, {
      ...(detail === undefined ? {} : { detail }),
      ...(bytes === undefined ? {} : { bytes }),
    });
  }

  /**
   * A human-readable line. Printed to stdout in human mode and to stderr in
   * `--json` mode, where stdout must stay machine-readable.
   */
  note(text: string): void {
    const line = this.#env.redact(text);
    if (this.json) {
      this.#stderr(`${line}\n`);
      return;
    }
    this.#stdout(`${line}\n`);
  }

  /** A heading in human mode; a no-op for the envelope. */
  heading(text: string): void {
    if (this.json) return;
    this.#stdout(`\n${this.#env.redact(text)}\n`);
  }

  setSummary(text: string): void {
    this.#summary = this.#env.redact(text);
  }

  /** Record a failure without ending the run (used for collected issues). */
  error(error: unknown, target?: string): void {
    const cliError = toCliError(error);
    this.#errors.push({
      message: this.#env.redact(cliError.message),
      ...(target === undefined ? {} : { target: this.#env.redact(target) }),
    });
    for (const issue of cliError.issues) {
      this.#errors.push({
        message: this.#env.redact(issue),
        ...(target === undefined ? {} : { target: this.#env.redact(target) }),
      });
    }
  }

  /** Build the envelope for the current run. */
  toEnvelope(code: ExitCode): Envelope {
    return buildEnvelope({
      command: this.command,
      code,
      dryRun: this.dryRun,
      summary: this.#summary,
      actions: this.#actions,
      errors: this.#errors,
    });
  }

  /**
   * Write the run's output exactly once and return the exit code.
   */
  finish(code: ExitCode): ExitCode {
    if (this.#finished) return code;
    this.#finished = true;

    if (this.json) {
      this.#stdout(stringifyEnvelope(this.toEnvelope(code)));
      return code;
    }

    if (code !== 0 && this.#errors.length > 0) {
      this.#stderr("\n");
      for (const issue of this.#errors) {
        this.#stderr(
          `error: ${issue.message}${issue.target === undefined ? "" : ` [${issue.target}]`}\n`,
        );
      }
    }

    if (this.#summary.length > 0) {
      this.#stdout(`\n${this.#summary}\n`);
    }

    if (code !== 0) {
      this.#stderr(`exit code ${code}\n`);
    }

    return code;
  }
}
