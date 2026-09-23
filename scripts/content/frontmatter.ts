import * as yaml from "js-yaml";

import { ValidationError } from "../lib/errors.js";

/**
 * Frontmatter parsing and rendering.
 *
 * The parser is strict in the ways that matter for a content pipeline whose
 * output is immutable once published:
 *
 * - the document must open with a `---` line at column 0 and close with one
 *   outside any block scalar, so a YAML-looking file with no frontmatter is an
 *   error rather than a file with silently empty metadata, and a `---` written
 *   inside a literal block is prose rather than an early end to the metadata;
 * - duplicate keys, anchors, aliases, merge keys and non-core tags are all
 *   rejected, because they are ways to make two readers of the same file
 *   disagree about what it says;
 * - every reported line number is a file line number, so an author can jump to
 *   it in an editor;
 * - the root must be a mapping, and every value is handed to Zod as `unknown`
 *   so the schema decides what a field means;
 * - a byte-order mark or a CRLF line ending is an error rather than something
 *   quietly normalised, because release content is defined as UTF-8 with LF
 *   endings and an author should not discover that at upload time.
 */

export interface ParsedDocument {
  /** The raw frontmatter mapping, before any schema is applied. */
  readonly data: Record<string, unknown>;
  /** Everything after the closing delimiter. */
  readonly body: string;
  /** The YAML text between the delimiters. */
  readonly frontmatterText: string;
  /** 1-based line number of the first body line. */
  readonly bodyStartLine: number;
}

export class FrontmatterError extends ValidationError {
  constructor(message: string, options: { issues?: readonly string[] } = {}) {
    super(message, options);
    this.name = "FrontmatterError";
  }
}

const OPENING = "---";
const CLOSING = "---";

/**
 * A YAML block scalar header (`description: |`, `- >-`, `text: |2`).
 *
 * The scan below uses it to tell a `---` line that is *content* from one that is
 * the closing delimiter. A block scalar's body is every following line that is
 * blank or indented deeper than its header, so an indented `---` inside a
 * literal block is prose, and treating it as the delimiter truncated the
 * frontmatter in the middle of a string.
 *
 * The pattern is deliberately over-eager: a plain value that happens to end in
 * `>` or `|` also matches. That is the safe direction — it can only make the
 * scan skip indented lines, while a delimiter at column 0 is never skipped.
 */
const BLOCK_SCALAR_HEADER = /(?:^|[\s:[{,-])[|>](?:\d+)?[-+]?\s*(?:#.*)?$/u;

function indentationOf(line: string): number {
  let spaces = 0;
  while (line[spaces] === " ") spaces += 1;
  return spaces;
}

/**
 * True when a line is part of a block scalar opened at `headerIndent`. A blank
 * line belongs to the scalar; so does anything indented deeper than the header.
 * Column 0 ends it, whatever it says.
 */
function isBlockScalarContent(line: string, headerIndent: number): boolean {
  if (line.trim().length === 0) return true;
  return indentationOf(line) > headerIndent;
}

/**
 * The line index of the frontmatter's closing delimiter, or `-1`.
 *
 * The delimiter is a line that says exactly `---` at column 0 — the same text
 * the opening delimiter is matched against — outside any block scalar.
 */
function findClosingDelimiter(lines: readonly string[]): number {
  let blockIndent = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (blockIndent >= 0) {
      if (isBlockScalarContent(line, blockIndent)) continue;
      blockIndent = -1;
    }

    if (line === CLOSING) return index;
    if (BLOCK_SCALAR_HEADER.test(line)) blockIndent = indentationOf(line);
  }

  return -1;
}

function lineNumberOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * Convert a line number *inside* a block of text into the line number of the
 * file that text was cut from. `firstLine` is the file line the block starts on.
 */
function fileLine(lineInText: number, firstLine: number): number {
  return firstLine + lineInText - 1;
}

function describeYamlError(
  error: unknown,
  label: string,
  firstLine: number,
): string {
  if (error instanceof yaml.YAMLException) {
    const line =
      error.mark?.line === undefined
        ? null
        : fileLine(error.mark.line + 1, firstLine);
    const reason =
      error.reason ?? error.message.split("\n")[0] ?? "unknown YAML error";
    return `${label}${line === null ? "" : `:${line}`}: ${reason}`;
  }
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Reject the YAML features that make a document ambiguous.
 *
 * Anchors and aliases let one value appear in two places; merge keys and
 * explicit tags do the same through a different route. All of them are
 * invisible in a rendered page and all of them can change meaning depending on
 * the parser, so frontmatter is not allowed to use them.
 *
 * Reported line numbers are file line numbers. `text` is the frontmatter block,
 * which starts on file line `firstLine`, so a message that quoted a line from
 * inside the block without shifting it pointed one line above the real one.
 */
function assertNoAmbiguousYaml(
  text: string,
  label: string,
  firstLine: number,
): void {
  let events: yaml.Event[];
  try {
    events = yaml.parseEvents(text, {});
  } catch (error) {
    throw new FrontmatterError(describeYamlError(error, label, firstLine));
  }

  for (const event of events) {
    if (event.type === yaml.EVENT_ALIAS) {
      throw new FrontmatterError(
        `${label}:${fileLine(lineNumberOf(text, event.anchorStart), firstLine)}: YAML aliases are not allowed in frontmatter.`,
      );
    }
    if ("anchorStart" in event && event.anchorStart >= 0) {
      throw new FrontmatterError(
        `${label}:${fileLine(lineNumberOf(text, event.anchorStart), firstLine)}: YAML anchors are not allowed in frontmatter.`,
      );
    }
  }
}

/** Merge keys survive parsing as a literal `<<`; they are refused after the fact. */
function assertNoMergeKeys(value: unknown, label: string, path = "$"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoMergeKeys(item, label, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "<<") {
      throw new FrontmatterError(
        `${label}: YAML merge keys ("<<") are not allowed in frontmatter (at ${path}).`,
      );
    }
    assertNoMergeKeys(child, label, `${path}.${key}`);
  }
}

/**
 * Parse a YAML mapping, rejecting everything ambiguous.
 *
 * `firstLine` is the file line the first line of `text` sits on, so every
 * reported line number can be one the author can jump to. It defaults to 1 for
 * a caller holding a fragment that is itself the file.
 */
export function parseYamlMapping(
  text: string,
  label: string,
  firstLine = 1,
): Record<string, unknown> {
  assertNoAmbiguousYaml(text, label, firstLine);

  let value: unknown;
  try {
    value = yaml.load(text, { filename: label });
  } catch (error) {
    throw new FrontmatterError(describeYamlError(error, label, firstLine));
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterError(
      `${label}: frontmatter must be a YAML mapping, but the document is ${value === null ? "empty" : Array.isArray(value) ? "a sequence" : typeof value}.`,
    );
  }

  assertNoMergeKeys(value, label);
  return value as Record<string, unknown>;
}

/**
 * Split a Markdown/MDX document into frontmatter and body.
 *
 * `bodyStartLine` lets a validator report "line 12" in the file the author is
 * looking at rather than a line number inside the body.
 */
export function parseDocument(source: string, label: string): ParsedDocument {
  if (source.charCodeAt(0) === 0xfeff) {
    throw new FrontmatterError(
      `${label}: the file starts with a UTF-8 byte order mark.`,
    );
  }
  if (source.includes("\r")) {
    throw new FrontmatterError(
      `${label}: the file contains CR bytes; content files must use LF endings.`,
    );
  }

  const lines = source.split("\n");
  // Exactly the delimiter, at column 0: `  ---` is a YAML line, not an opening
  // delimiter, and accepting it would make a document whose first line is an
  // indented scalar look as though it had frontmatter.
  if (lines[0] !== OPENING) {
    throw new FrontmatterError(
      `${label}: the file must begin with a "---" line at the start of the file, followed by YAML frontmatter.`,
    );
  }

  const closingIndex = findClosingDelimiter(lines);

  if (closingIndex === -1) {
    throw new FrontmatterError(
      `${label}: the frontmatter block is never closed with a "---" line.`,
    );
  }

  const frontmatterText = lines.slice(1, closingIndex).join("\n");

  /*
   * The body is everything after the closing delimiter, minus the single blank
   * line that conventionally separates the two. That line belongs to the
   * delimiter rather than to the prose, and counting it as body content would
   * break the round trip this module promises: `renderDocument` re-emits a
   * blank line after the frontmatter, so keeping it here would add one more
   * every time a document was rewritten.
   */
  const bodyLines = lines.slice(closingIndex + 1);
  const body =
    bodyLines[0]?.trim() === ""
      ? bodyLines.slice(1).join("\n")
      : bodyLines.join("\n");

  return {
    // The frontmatter text starts on file line 2; passing that through is what
    // makes a YAML error report the line the author sees in their editor.
    data: parseYamlMapping(frontmatterText, label, 2),
    body,
    frontmatterText,
    bodyStartLine: closingIndex + 2,
  };
}

/** Render a mapping as a frontmatter block, without the trailing body. */
export function dumpFrontmatter(data: Record<string, unknown>): string {
  const text = yaml.dump(data, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Render a complete document: frontmatter between delimiters, then the body. */
export function renderDocument(
  data: Record<string, unknown>,
  body: string,
): string {
  const frontmatter = dumpFrontmatter(data);
  const normalizedBody =
    body.length === 0 ? "" : `${body.replace(/\n+$/u, "")}\n`;
  return `---\n${frontmatter}\n---\n\n${normalizedBody}`;
}

/**
 * Replace the frontmatter of a document, keeping its body byte-for-byte.
 *
 * `content:seo` writes suggestions and never rewrites Markdown, but a future
 * command that does apply frontmatter edits would go through this function, so
 * the body-preserving guarantee lives here with a test rather than in a caller.
 */
export function replaceFrontmatter(
  source: string,
  data: Record<string, unknown>,
  label: string,
): string {
  const parsed = parseDocument(source, label);
  return renderDocument(data, parsed.body);
}
