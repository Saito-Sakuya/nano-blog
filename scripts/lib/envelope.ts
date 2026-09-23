import type { ExitCode } from "./errors.js";

/**
 * The `--json` envelope.
 *
 * Exactly seven top-level keys, always all of them, always in this order. In
 * `--json` mode this object is the only thing written to stdout: a caller can
 * pipe it straight into `JSON.parse` without stripping log lines first.
 */

export type ActionKind =
  | "plan"
  | "put"
  | "reuse"
  | "skip"
  | "delete"
  | "activate"
  | "deploy"
  | "download"
  | "write"
  | "verify"
  | "noop";

export interface EnvelopeAction {
  /** What the command did, or would do. */
  readonly kind: ActionKind;
  /** The object key, file path or release this action concerns. */
  readonly target: string;
  readonly detail?: string;
  readonly bytes?: number;
}

export interface EnvelopeError {
  readonly message: string;
  readonly target?: string;
}

export interface Envelope {
  readonly ok: boolean;
  readonly code: ExitCode;
  readonly command: string;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly actions: readonly EnvelopeAction[];
  readonly errors: readonly EnvelopeError[];
}

export const ENVELOPE_KEYS: readonly (keyof Envelope)[] = [
  "ok",
  "code",
  "command",
  "dryRun",
  "summary",
  "actions",
  "errors",
];

export interface EnvelopeInput {
  readonly command: string;
  readonly code: ExitCode;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly actions: readonly EnvelopeAction[];
  readonly errors: readonly EnvelopeError[];
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
  return {
    ok: input.code === 0,
    code: input.code,
    command: input.command,
    dryRun: input.dryRun,
    summary: input.summary,
    actions: [...input.actions],
    errors: [...input.errors],
  };
}

/** Serialise an envelope as one line of JSON. */
export function stringifyEnvelope(envelope: Envelope): string {
  return `${JSON.stringify({
    ok: envelope.ok,
    code: envelope.code,
    command: envelope.command,
    dryRun: envelope.dryRun,
    summary: envelope.summary,
    actions: envelope.actions,
    errors: envelope.errors,
  })}\n`;
}
