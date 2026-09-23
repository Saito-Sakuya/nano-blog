/**
 * A unified diff.
 *
 * Used to show what a Workers AI suggestion would change in a file's
 * frontmatter. It is a real diff — longest-common-subsequence based, with
 * `@@` hunks and configurable context — so the output can be read by `patch`
 * or any diff tool, not just by a human.
 *
 * Pure: it takes two strings and returns one.
 */

export interface UnifiedDiffOptions {
  /** Lines of unchanged context around each change. */
  readonly context?: number;
  readonly fromLabel?: string;
  readonly toLabel?: string;
}

type EditKind = "keep" | "remove" | "add";

interface Edit {
  readonly kind: EditKind;
  readonly text: string;
  /** 1-based line number in the "before" text, or null for an addition. */
  readonly beforeLine: number | null;
  /** 1-based line number in the "after" text, or null for a removal. */
  readonly afterLine: number | null;
}

const DEFAULT_CONTEXT = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence of two line arrays, returned as an edit script.
 *
 * The table is built iteratively over the shorter side to keep memory
 * reasonable; the inputs here are frontmatter-sized, so the straightforward
 * formulation is used for clarity.
 */
function diffLines(
  before: readonly string[],
  after: readonly string[],
): Edit[] {
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    const rowEntries = table[row];
    const nextRow = table[row + 1];
    if (rowEntries === undefined || nextRow === undefined) continue;

    for (let column = columns - 1; column >= 0; column -= 1) {
      const beforeLine = before[row];
      const afterLine = after[column];
      rowEntries[column] =
        beforeLine === afterLine
          ? (nextRow[column + 1] ?? 0) + 1
          : Math.max(nextRow[column] ?? 0, rowEntries[column + 1] ?? 0);
    }
  }

  const edits: Edit[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    const beforeLine = before[row] ?? "";
    const afterLine = after[column] ?? "";

    if (beforeLine === afterLine) {
      edits.push({
        kind: "keep",
        text: beforeLine,
        beforeLine: row + 1,
        afterLine: column + 1,
      });
      row += 1;
      column += 1;
      continue;
    }

    const skipBefore = table[row + 1]?.[column] ?? 0;
    const skipAfter = table[row]?.[column + 1] ?? 0;

    if (skipBefore >= skipAfter) {
      edits.push({
        kind: "remove",
        text: beforeLine,
        beforeLine: row + 1,
        afterLine: null,
      });
      row += 1;
      continue;
    }

    edits.push({
      kind: "add",
      text: afterLine,
      beforeLine: null,
      afterLine: column + 1,
    });
    column += 1;
  }

  while (row < rows) {
    edits.push({
      kind: "remove",
      text: before[row] ?? "",
      beforeLine: row + 1,
      afterLine: null,
    });
    row += 1;
  }

  while (column < columns) {
    edits.push({
      kind: "add",
      text: after[column] ?? "",
      beforeLine: null,
      afterLine: column + 1,
    });
    column += 1;
  }

  return edits;
}

/**
 * Render a unified diff. Returns an empty string when the two texts are equal,
 * because "no changes" is not a diff.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  if (before === after) return "";

  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT);
  const edits = diffLines(splitLines(before), splitLines(after));

  const changed = edits
    .map((edit, index) => ({ edit, index }))
    .filter((entry) => entry.edit.kind !== "keep")
    .map((entry) => entry.index);

  if (changed.length === 0) return "";

  const included = new Set<number>();
  for (const index of changed) {
    for (let offset = -context; offset <= context; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < edits.length) included.add(candidate);
    }
  }

  const ordered = [...included].sort((a, b) => a - b);
  const hunks: number[][] = [];
  let current: number[] = [];

  for (const index of ordered) {
    const last = current[current.length - 1];
    if (last === undefined || index === last + 1) {
      current.push(index);
      continue;
    }
    hunks.push(current);
    current = [index];
  }
  if (current.length > 0) hunks.push(current);

  const fromLabel = options.fromLabel ?? "before";
  const toLabel = options.toLabel ?? "after";
  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  for (const hunk of hunks) {
    const first = hunk[0];
    const last = hunk[hunk.length - 1];
    if (first === undefined || last === undefined) continue;

    const slice = edits.slice(first, last + 1);
    const beforeLines = slice.filter((edit) => edit.kind !== "add");
    const afterLines = slice.filter((edit) => edit.kind !== "remove");

    const beforeStart = beforeLines[0]?.beforeLine ?? 0;
    const afterStart = afterLines[0]?.afterLine ?? 0;

    lines.push(
      `@@ -${beforeStart},${beforeLines.length} +${afterStart},${afterLines.length} @@`,
    );

    for (const edit of slice) {
      const prefix =
        edit.kind === "keep" ? " " : edit.kind === "remove" ? "-" : "+";
      lines.push(`${prefix}${edit.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
