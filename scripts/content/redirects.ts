import { readFile } from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { pathExists } from "../lib/fs-util.js";
import type { ContentIssue } from "./load.js";

/**
 * The redirect table.
 *
 * `public/_redirects` is a version-controlled data file in Cloudflare Pages'
 * own format — `from  to  [status]`, one rule per line, `#` for comments — and
 * it is the only place a moved URL may be expressed. Three failures must not
 * appear in this file: a loop, a chain
 * of hops, and a destination that does not exist. A fourth rule is implicit in
 * the same sentence: catch-all redirects are forbidden, so a rule may not send
 * every unknown URL to the home page.
 *
 * The checks live here rather than in `validate.ts` because they read a file
 * outside the content source: the table is a property of the site, not of a
 * particular release, so the same table is validated whichever content mode is
 * being built.
 */

/** The redirect file, relative to the repository root. */
export const REDIRECTS_PATH = "public/_redirects";

/** Status codes Cloudflare Pages accepts on a redirect rule. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

export interface RedirectRule {
  readonly from: string;
  readonly to: string;
  readonly status: number;
  /** 1-based line number in the source file, for error messages. */
  readonly line: number;
}

export type RedirectParseResult =
  | { readonly ok: true; readonly rules: readonly RedirectRule[] }
  | { readonly ok: false; readonly issues: readonly ContentIssue[] };

/**
 * Parse the redirect table.
 *
 * Every syntax problem is reported rather than skipped: a line this parser
 * silently ignored would be a redirect that exists in the repository and does
 * nothing on the platform, which is the worst of both worlds.
 */
export function parseRedirects(text: string): RedirectParseResult {
  const issues: ContentIssue[] = [];
  const rules: RedirectRule[] = [];
  const lines = text.split(/\r?\n/u);

  lines.forEach((raw, index) => {
    const line = index + 1;
    const withoutComment = raw.split("#")[0] ?? "";
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) return;

    const fields = trimmed.split(/\s+/u);
    if (fields.length < 2 || fields.length > 3) {
      issues.push({
        severity: "error",
        code: "redirect-syntax",
        message: `${REDIRECTS_PATH}:${line}: a rule needs a source, a destination and an optional status code, but this line has ${fields.length} field(s).`,
        file: `${REDIRECTS_PATH}:${line}`,
      });
      return;
    }

    const [from, to, statusField] = fields;
    if (from === undefined || to === undefined) {
      issues.push({
        severity: "error",
        code: "redirect-syntax",
        message: `${REDIRECTS_PATH}:${line}: a rule needs both a source and a destination.`,
        file: `${REDIRECTS_PATH}:${line}`,
      });
      return;
    }

    let status = 301;
    if (statusField !== undefined) {
      const parsed = Number(statusField);
      if (!Number.isInteger(parsed) || !REDIRECT_STATUSES.includes(parsed)) {
        issues.push({
          severity: "error",
          code: "redirect-status",
          message: `${REDIRECTS_PATH}:${line}: status ${JSON.stringify(statusField)} is not one of ${REDIRECT_STATUSES.join(", ")}.`,
          file: `${REDIRECTS_PATH}:${line}`,
        });
        return;
      }
      status = parsed;
    }

    // A wildcard or a `:placeholder` turns a rule into a catch-all, which the
    // specification forbids outright — so the whole line is rejected before the
    // paths are even compared.
    if (from.includes("*") || from.includes(":") || to.includes("*")) {
      issues.push({
        severity: "error",
        code: "redirect-catch-all",
        message: `${REDIRECTS_PATH}:${line}: wildcard and placeholder sources are not allowed; sending unknown URLs to one destination is forbidden. Add one explicit rule per moved URL.`,
        file: `${REDIRECTS_PATH}:${line}`,
      });
      return;
    }

    // A placeholder in the destination only works alongside a wildcard source,
    // which has just been rejected; on its own it names no real page.
    if (to.includes(":")) {
      issues.push({
        severity: "error",
        code: "redirect-catch-all",
        message: `${REDIRECTS_PATH}:${line}: the destination ${JSON.stringify(to)} contains a placeholder that no source supplies.`,
        file: `${REDIRECTS_PATH}:${line}`,
      });
      return;
    }

    for (const [label, value] of [
      ["source", from],
      ["destination", to],
    ] as const) {
      if (!value.startsWith("/")) {
        issues.push({
          severity: "error",
          code: "redirect-syntax",
          message: `${REDIRECTS_PATH}:${line}: the ${label} ${JSON.stringify(value)} must be a site-absolute path beginning with "/".`,
          file: `${REDIRECTS_PATH}:${line}`,
        });
        return;
      }
    }

    rules.push({ from, to, status, line });
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rules };
}

export interface RedirectValidationContext {
  /** URLs that a built site will actually serve, content plus reserved routes. */
  readonly knownUrls: ReadonlySet<string>;
  /** Paths that need no trailing slash, such as `/rss.xml`. */
  readonly staticFiles: readonly string[];
}

/**
 * Normalise a URL for comparison.
 *
 * Every HTML path carries exactly one trailing slash, so `/posts/a` and
 * `/posts/a/` are the same destination. A file — anything whose last segment
 * contains a dot, such as `/rss.xml` or `/favicon.svg` — must NOT be given one:
 * adding it would turn a valid redirect into a reported dead link, which is
 * exactly the false positive this function exists to prevent.
 */
function normalizeUrl(value: string): string {
  const withoutHash = (value.split("#")[0] ?? "").split("?")[0] ?? "";
  if (withoutHash.length === 0 || withoutHash === "/") return "/";
  if (withoutHash.endsWith("/")) return withoutHash;

  const lastSegment = withoutHash.slice(withoutHash.lastIndexOf("/") + 1);
  return withoutHash.includes(".") && lastSegment.includes(".")
    ? withoutHash
    : `${withoutHash}/`;
}

/**
 * Validate the parsed table against the URLs the site will serve.
 *
 * Loops and chains are detected on the graph rather than on adjacent pairs, so
 * `a -> b -> c -> a` is reported as a cycle even though no two consecutive
 * rules form one.
 */
export function validateRedirects(
  rules: readonly RedirectRule[],
  context: RedirectValidationContext,
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const at = (rule: RedirectRule): string => `${REDIRECTS_PATH}:${rule.line}`;

  const byFrom = new Map<string, RedirectRule>();
  for (const rule of rules) {
    const key = normalizeUrl(rule.from);
    const existing = byFrom.get(key);
    if (existing !== undefined) {
      issues.push({
        severity: "error",
        code: "redirect-duplicate",
        message: `${at(rule)}: ${rule.from} already has a rule on line ${existing.line}; one source may appear once.`,
        file: at(rule),
      });
      continue;
    }
    byFrom.set(key, rule);
  }

  const known = new Set<string>();
  for (const url of context.knownUrls) known.add(normalizeUrl(url));
  for (const file of context.staticFiles) known.add(file);

  // One message per distinct cycle, however many of its rules are walked.
  const reportedCycles = new Set<string>();

  for (const rule of rules) {
    const from = normalizeUrl(rule.from);
    const to = normalizeUrl(rule.to);

    if (from === to) {
      issues.push({
        severity: "error",
        code: "redirect-loop",
        message: `${at(rule)}: ${rule.from} redirects to itself.`,
        file: at(rule),
      });
      continue;
    }

    if (!known.has(to)) {
      issues.push({
        severity: "error",
        code: "redirect-target",
        message: `${at(rule)}: ${rule.to} is not a page this site will serve, so the redirect would land on a 404.`,
        file: at(rule),
      });
    }

    // Follow the destinations until the path leaves the table. Arriving at a
    // node already on the path means the reader would never arrive anywhere.
    const visited = new Set<string>([from]);
    const order: string[] = [from];
    let current = to;
    let firstHop: RedirectRule | undefined;
    let cycle: string[] | null = null;

    for (;;) {
      if (visited.has(current)) {
        cycle = [...order.slice(order.indexOf(current)), current];
        break;
      }
      const next = byFrom.get(current);
      if (next === undefined) break;
      firstHop ??= next;
      visited.add(current);
      order.push(current);
      current = normalizeUrl(next.to);
    }

    if (cycle !== null) {
      const signature = [...cycle].slice(0, -1).sort().join("|");
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        issues.push({
          severity: "error",
          code: "redirect-loop",
          message: `${at(rule)}: ${cycle.join(" → ")} is a redirect loop.`,
          file: at(rule),
        });
      }
      continue;
    }

    // A destination that is itself redirected costs the reader a second round
    // trip, so point the rule at the end of the chain instead.
    if (firstHop !== undefined) {
      issues.push({
        severity: "error",
        code: "redirect-chain",
        message: `${at(rule)}: ${rule.to} is itself redirected by the rule on line ${firstHop.line}; point this rule straight at ${firstHop.to} so the reader makes one hop instead of two.`,
        file: at(rule),
      });
    }
  }

  return issues;
}

/** Read and validate the checked-in redirect table. */
export async function checkRedirects(
  knownUrls: ReadonlySet<string>,
  staticFiles: readonly string[],
): Promise<ContentIssue[]> {
  const absolute = path.join(PROJECT_ROOT, REDIRECTS_PATH);
  if (!(await pathExists(absolute))) {
    return [
      {
        severity: "error",
        code: "redirect-missing",
        message: `${REDIRECTS_PATH} is missing; it is part of the deployed configuration and must stay in the repository even when it holds no rules.`,
        file: REDIRECTS_PATH,
      },
    ];
  }

  const text = await readFile(absolute, "utf8");
  const parsed = parseRedirects(text);
  if (!parsed.ok) return [...parsed.issues];

  return validateRedirects(parsed.rules, { knownUrls, staticFiles });
}
