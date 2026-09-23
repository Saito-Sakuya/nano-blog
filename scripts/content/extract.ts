import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { CALLOUT_TYPES } from "../../src/lib/markdown/remark-callouts.js";
import { parseCodeFence } from "../../src/lib/markdown/code-fence.js";
import {
  MDX_COMPONENT_NAMES,
  validateMdx,
  type MdxIssue,
} from "../../src/lib/markdown/mdx-validate.js";
import { createHeadingSlugger } from "../../src/lib/markdown/slug.js";

/**
 * Reading a document body without rendering it.
 *
 * Validation needs to know what is *in* a file — which headings it has, which
 * links and media it references, whether any of it is visible prose — and it
 * needs to know it precisely enough to refuse a release. The Markdown parser
 * here is the same one the build uses, so a construct that parses at validation
 * time parses at build time.
 *
 * Heading ids come from `createHeadingSlugger`, the same stateful slugger
 * `remark-heading-anchors` uses when it renders, so an anchor validated here is
 * an anchor the page actually has. Slugs are de-duplicated in document order:
 * the base slug alone is not an id.
 *
 * MDX is the exception. A full MDX parse belongs to the build's own plugin
 * chain, and the gate below is the AST validator in
 * `src/lib/markdown/mdx-validate.ts` — the same module the build-time checks
 * use. There is deliberately no second, textual copy of those rules: a regular
 * expression scan is both easier to fool (`ONCLICK=`, `STYLE=` in a different
 * case) and harder to keep in agreement with the components it describes.
 */

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * The slice of an mdast node this module reads.
 *
 * Declared structurally rather than imported from `mdast`, so the author
 * tooling depends on the parser's *output shape* and not on a type package
 * being installed. The tree is walked by hand for the same reason: the walk is
 * small, and it keeps every field access explicit.
 */
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly url?: string;
  readonly alt?: string | null;
  readonly children?: readonly MarkdownNode[];
  readonly position?: { readonly start?: { readonly line?: number } };
}

function childrenOf(node: MarkdownNode): readonly MarkdownNode[] {
  return node.children ?? [];
}

export interface ExtractedLink {
  readonly url: string;
  readonly text: string;
  readonly line: number | null;
}

export interface ExtractedHeading {
  readonly depth: number;
  readonly text: string;
  readonly slug: string;
  readonly line: number | null;
}

export interface ExtractedFence {
  readonly info: string;
  readonly line: number | null;
  readonly lineCount: number;
}

export interface ExtractedMedia {
  readonly path: string;
  readonly alt: string | null;
  readonly line: number | null;
}

export interface ExtractedCallout {
  readonly type: string;
  readonly line: number | null;
}

export interface ExtractedDocument {
  readonly headings: readonly ExtractedHeading[];
  readonly links: readonly ExtractedLink[];
  readonly fences: readonly ExtractedFence[];
  readonly media: readonly ExtractedMedia[];
  readonly callouts: readonly ExtractedCallout[];
  /** True when the body has at least one visible, non-heading content node. */
  readonly hasVisibleContent: boolean;
  readonly h1Lines: readonly number[];
  readonly problems: readonly string[];
  /** Capitalised component names used in an MDX body. */
  readonly components: readonly string[];
}

/** The MDX components the allow-list permits. */
export const ALLOWED_MDX_COMPONENTS: readonly string[] = MDX_COMPONENT_NAMES;

function lineOf(node: MarkdownNode): number | null {
  return node.position?.start?.line ?? null;
}

/**
 * The text of a node, the way the renderer computes it.
 *
 * This mirrors `mdast-util-to-string`, which `remark-heading-anchors` uses to
 * derive a heading's id. The two must agree on every heading, or an anchor that
 * validation accepts is an anchor the page does not have, so a node's own
 * `value` and an image's `alt` are read before its children are joined.
 */
function textOf(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  if (typeof node.alt === "string") return node.alt;
  return childrenOf(node).map(textOf).join("");
}

/** Capitalised component names used in a body, for reporting. */
function componentNamesIn(body: string): string[] {
  const names = new Set<string>();
  const pattern = /<([A-Z][\w.]*)[\s/>]/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }

  return [...names];
}

/** One issue from the MDX validator, in this module's `file:line` form. */
function formatMdxIssue(file: string, issue: MdxIssue): string {
  const where = issue.line === null ? file : `${file}:${issue.line}`;
  return `${where}: ${issue.message}`;
}

export function extractDocument(
  body: string,
  options: { readonly file: string; readonly mdx: boolean },
): ExtractedDocument {
  const problems: string[] = [];
  const headings: ExtractedHeading[] = [];
  const links: ExtractedLink[] = [];
  const fences: ExtractedFence[] = [];
  const media: ExtractedMedia[] = [];
  const callouts: ExtractedCallout[] = [];
  const h1Lines: number[] = [];
  let hasVisibleContent = false;

  // One slugger per document, exactly as the renderer creates one per document.
  const slug = createHeadingSlugger();

  let tree: MarkdownNode;
  try {
    tree = parser.parse(body) as unknown as MarkdownNode;
  } catch (error) {
    problems.push(
      `${options.file}: the body could not be parsed as Markdown: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      headings,
      links,
      fences,
      media,
      callouts,
      hasVisibleContent: body.trim().length > 0,
      h1Lines,
      problems,
      components: [],
    };
  }

  const walk = (node: MarkdownNode): void => {
    switch (node.type) {
      case "heading": {
        const text = textOf(node);
        headings.push({
          depth: node.depth ?? 1,
          text,
          slug: slug(text),
          line: lineOf(node),
        });
        if (node.depth === 1) h1Lines.push(lineOf(node) ?? 0);
        break;
      }

      case "code": {
        const line = lineOf(node);
        const value = node.value ?? "";
        const lineCount = value.split("\n").length;
        const info = [node.lang ?? "", node.meta ?? ""]
          .filter((part) => part.length > 0)
          .join(" ");
        fences.push({ info, line, lineCount });
        try {
          parseCodeFence(info, lineCount);
        } catch (error) {
          problems.push(
            `${options.file}:${line ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        hasVisibleContent = true;
        break;
      }

      case "link": {
        links.push({
          url: node.url ?? "",
          text: textOf(node),
          line: lineOf(node),
        });
        hasVisibleContent = true;
        break;
      }

      case "image": {
        media.push({
          path: node.url ?? "",
          alt: node.alt ?? null,
          line: lineOf(node),
        });
        break;
      }

      case "text": {
        if ((node.value ?? "").trim().length > 0) hasVisibleContent = true;
        break;
      }

      case "paragraph":
      case "list":
      case "table":
      case "blockquote": {
        if (textOf(node).trim().length > 0) hasVisibleContent = true;
        break;
      }

      default:
        break;
    }

    for (const child of childrenOf(node)) walk(child);
  };

  walk(tree);

  // Callouts are blockquotes whose first line is a GitHub alert marker.
  for (const [index, line] of body.split("\n").entries()) {
    const callout = /^\s*>\s*\[!([A-Za-z]+)\]/u.exec(line);
    if (callout === null) continue;
    const type = (callout[1] ?? "").toUpperCase();
    callouts.push({ type, line: index + 1 });
    if (!(CALLOUT_TYPES as readonly string[]).includes(type)) {
      problems.push(
        `${options.file}:${index + 1}: callout type [!${type}] is not one of ${CALLOUT_TYPES.join(", ")}.`,
      );
    }
  }

  let components: string[] = [];
  if (options.mdx) {
    components = componentNamesIn(body);
    // The MDX safety boundary is a real AST pass, and it is the same one the
    // build-time gate uses. Its issues are errors for the same reason the
    // textual checks it replaced were: an `.mdx` file is compiled and executed.
    for (const issue of validateMdx(body, options.file)) {
      problems.push(formatMdxIssue(options.file, issue));
    }
  }

  return {
    headings,
    links,
    fences,
    media,
    callouts,
    hasVisibleContent,
    h1Lines,
    problems,
    components,
  };
}
