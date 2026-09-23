/**
 * Strict parser for the fenced-code info string.
 *
 * The locked syntax is:
 *
 *     <language> title="optional title" showLineNumbers {2,4-6}
 *
 * The parser is deliberately unforgiving. A malformed fence is an authoring
 * mistake that must stop the build rather than silently render something the
 * author did not ask for. It rejects unclosed quotes, reversed ranges,
 * negative or zero line numbers, and highlight lines beyond the block.
 */

export class CodeFenceError extends Error {
  override readonly name = "CodeFenceError";
}

export interface CodeFenceMeta {
  /** Fence language, or `null` when the fence carried no info string. */
  readonly lang: string | null;
  /** Optional human-readable block title. */
  readonly title: string | null;
  /** Whether the block asks for visible line numbers. */
  readonly showLineNumbers: boolean;
  /** Zero-based line indexes to emphasise, ascending and de-duplicated. */
  readonly highlight: readonly number[];
}

const RANGE_TOKEN = /^\{([^}]*)\}$/u;

/**
 * Split an info string into whitespace-separated tokens, keeping quoted values
 * intact. Throws when a quote is opened and never closed.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;

  for (const char of input) {
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (!inQuote && /\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (inQuote) {
    throw new CodeFenceError(
      `Unclosed quote in code fence info string: ${JSON.stringify(input)}`,
    );
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse `2,4-6` (the inside of the braces) into zero-based line indexes.
 * Rejects anything that is not a positive integer or a forward-only range.
 */
function parseHighlightSpec(spec: string, info: string): number[] {
  const lines = new Set<number>();

  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) {
      throw new CodeFenceError(
        `Empty highlight entry in code fence: ${JSON.stringify(info)}`,
      );
    }

    const rangeMatch = /^(\d+)-(\d+)$/u.exec(piece);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end < 1) {
        throw new CodeFenceError(
          `Highlight line numbers start at 1: ${JSON.stringify(info)}`,
        );
      }
      if (end < start) {
        throw new CodeFenceError(
          `Highlight range ${piece} is reversed in code fence: ${JSON.stringify(info)}`,
        );
      }
      for (let line = start; line <= end; line += 1) {
        lines.add(line - 1);
      }
      continue;
    }

    if (!/^\d+$/u.test(piece)) {
      throw new CodeFenceError(
        `Highlight entry ${JSON.stringify(piece)} is not a line number or range: ${JSON.stringify(info)}`,
      );
    }
    const single = Number(piece);
    if (single < 1) {
      throw new CodeFenceError(
        `Highlight line numbers start at 1: ${JSON.stringify(info)}`,
      );
    }
    lines.add(single - 1);
  }

  return [...lines].sort((a, b) => a - b);
}

/**
 * Parse a fence info string. `lineCount` is only used to bound the highlight
 * ranges, so callers that do not have the code yet may omit it.
 */
export function parseCodeFence(
  info: string,
  lineCount?: number,
): CodeFenceMeta {
  const tokens = tokenize(info);

  let lang: string | null = null;
  let title: string | null = null;
  let showLineNumbers = false;
  let highlight: number[] = [];

  for (const [index, token] of tokens.entries()) {
    // The language is whatever appears before the first `key=value` pair or
    // flag, and only if it is the very first token.
    if (index === 0 && !token.includes("=") && !RANGE_TOKEN.test(token)) {
      lang = token.toLowerCase();
      continue;
    }

    if (token === "showLineNumbers") {
      showLineNumbers = true;
      continue;
    }

    const rangeMatch = RANGE_TOKEN.exec(token);
    if (rangeMatch) {
      highlight = parseHighlightSpec(rangeMatch[1] ?? "", info);
      continue;
    }

    const titleMatch = /^title=(.*)$/su.exec(token);
    if (titleMatch) {
      const rawValue = titleMatch[1] ?? "";
      if (
        !rawValue.startsWith('"') ||
        !rawValue.endsWith('"') ||
        rawValue.length < 2
      ) {
        throw new CodeFenceError(
          `Code fence title must be double-quoted: ${JSON.stringify(info)}`,
        );
      }
      const value = rawValue.slice(1, -1);
      if (value.length === 0) {
        throw new CodeFenceError(
          `Code fence title is empty: ${JSON.stringify(info)}`,
        );
      }
      title = value;
      continue;
    }

    throw new CodeFenceError(
      `Unknown code fence option ${JSON.stringify(token)} in ${JSON.stringify(info)}`,
    );
  }

  if (lineCount !== undefined) {
    for (const line of highlight) {
      if (line >= lineCount) {
        throw new CodeFenceError(
          `Highlight line ${line + 1} is beyond the end of a ${lineCount}-line code block: ${JSON.stringify(info)}`,
        );
      }
    }
  }

  return { lang, title, showLineNumbers, highlight };
}

/**
 * True when the info string carries nothing the renderer needs to act on,
 * beyond the language itself.
 */
export function isPlainFence(meta: CodeFenceMeta): boolean {
  return (
    meta.title === null && !meta.showLineNumbers && meta.highlight.length === 0
  );
}
