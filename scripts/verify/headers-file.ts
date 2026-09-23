import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A reader for `public/_headers`, so the local servers behave like Cloudflare.
 *
 * ## Why this exists
 *
 * `_headers` is applied by the platform, so nothing that runs on a developer's
 * machine ever saw it. That blind spot was not theoretical: the site shipped with
 * a `Content-Security-Policy` that forbade WebAssembly, Pagefind's index is
 * WebAssembly, and every local check passed while the search box on the deployed
 * site failed on every query. `pnpm preview` did not catch it, the integration
 * tests did not catch it, and the only reason it was found at all is that
 * someone applied the header by hand and loaded the page.
 *
 * The fix is to make the shared static server apply the same file the platform
 * applies, so a rule that breaks a page breaks a test on the same machine.
 *
 * ## What it implements
 *
 * The parts of the format this repository uses, and the semantics Cloudflare
 * documents for them:
 *
 *   - a rule is a URL pattern followed by indented `Name: value` lines;
 *   - every matching rule applies, in file order;
 *   - a header set by two rules is joined with `, ` rather than replaced;
 *   - `! Name` detaches a header a broader rule set.
 *
 * A splat (`*`) matches greedily. Unsupported syntax — a placeholder, a second
 * splat — is reported rather than silently ignored, because a rule that quietly
 * does nothing is how the original bug survived.
 */

export interface HeaderRule {
  /** The pattern as written, for diagnostics. */
  readonly pattern: string;
  /** Compiled matcher for `pathname`. */
  readonly matches: (pathname: string) => boolean;
  /** Assignments in file order. */
  readonly set: readonly { readonly name: string; readonly value: string }[];
  /** Header names detached by this rule. */
  readonly detach: readonly string[];
}

/** Compile one URL pattern the way Cloudflare matches them. */
export function compilePattern(
  pattern: string,
  source: string,
): (value: string) => boolean {
  if (pattern.length === 0) {
    throw new Error(`${source}: a header rule has an empty URL pattern.`);
  }
  if (pattern.includes(":") && /:[A-Za-z]/u.test(pattern)) {
    throw new Error(
      `${source}: the pattern ${pattern} uses a placeholder, which this reader does not implement.`,
    );
  }
  const splats = pattern.split("*").length - 1;
  if (splats > 1) {
    throw new Error(
      `${source}: the pattern ${pattern} has ${String(splats)} splats; Cloudflare allows one.`,
    );
  }

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`^${escaped.replace(/\\\*/gu, ".*")}$`, "u");
  return (value: string): boolean => expression.test(value);
}

/**
 * Parse the file.
 *
 * Comments (`#`) and blank lines are skipped. An assignment outside a rule, or a
 * rule with no assignments, is an error: both are almost certainly a mistake in
 * a file whose whole job is to be applied exactly.
 */
export function parseHeadersFile(
  text: string,
  source = "_headers",
): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: {
    pattern: string;
    set: { name: string; value: string }[];
    detach: string[];
  } | null = null;

  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    const indented = /^\s/u.test(line);
    if (!indented) {
      if (current !== null) {
        if (current.set.length === 0 && current.detach.length === 0) {
          throw new Error(
            `${source}:${String(index + 1)}: the rule ${current.pattern} declares no headers.`,
          );
        }
        rules.push({
          pattern: current.pattern,
          matches: compilePattern(
            current.pattern,
            `${source}:${String(index + 1)}`,
          ),
          set: current.set,
          detach: current.detach,
        });
      }
      current = { pattern: line.trim(), set: [], detach: [] };
      continue;
    }

    if (current === null) {
      throw new Error(
        `${source}:${String(index + 1)}: a header appears before any URL pattern.`,
      );
    }

    const entry = line.trim();
    const detached = /^!\s*(.+)$/u.exec(entry);
    if (detached !== null) {
      current.detach.push((detached[1] ?? "").trim().toLowerCase());
      continue;
    }

    const assignment = /^([^:]+):\s*(.*)$/u.exec(entry);
    if (assignment === null) {
      throw new Error(
        `${source}:${String(index + 1)}: "${entry}" is neither a header nor a detach.`,
      );
    }
    current.set.push({
      name: (assignment[1] ?? "").trim(),
      value: (assignment[2] ?? "").trim(),
    });
  }

  if (current !== null) {
    if (current.set.length === 0 && current.detach.length === 0) {
      throw new Error(
        `${source}: the rule ${current.pattern} declares no headers.`,
      );
    }
    rules.push({
      pattern: current.pattern,
      matches: compilePattern(current.pattern, source),
      set: current.set,
      detach: current.detach,
    });
  }

  return rules;
}

/**
 * The headers that apply to one request path, in the shape Node's server wants.
 *
 * Names are lower-cased because Node sends them that way and a duplicate in two
 * cases would be sent twice.
 */
export function headersForPath(
  rules: readonly HeaderRule[],
  pathname: string,
): Record<string, string> {
  const headers = new Map<string, string>();

  for (const rule of rules) {
    if (!rule.matches(pathname)) continue;

    // Detach first, then assign: a rule that both removes and sets a header
    // means "start from nothing", which is how the KaTeX exception is written.
    for (const name of rule.detach) headers.delete(name);

    for (const { name, value } of rule.set) {
      const key = name.toLowerCase();
      const existing = headers.get(key);
      // Joined rather than replaced, matching Cloudflare. A file that relies on
      // this looks like a mistake, which is why the reader documents it.
      headers.set(
        key,
        existing === undefined ? value : `${existing}, ${value}`,
      );
    }
  }

  return Object.fromEntries(headers);
}

/** Read and parse `<root>/_headers`, or an empty rule set when it is absent. */
export async function loadHeadersFile(
  root: string,
): Promise<readonly HeaderRule[]> {
  const file = path.join(root, "_headers");
  try {
    return parseHeadersFile(await readFile(file, "utf8"), file);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}
