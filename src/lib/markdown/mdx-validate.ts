import type {
  MdxJsxAttribute,
  MdxJsxAttributeValueExpression,
} from "mdast-util-mdx-jsx";
import type { Root } from "mdast";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { z } from "astro/zod";

import { classifyAuthorUrl } from "./sanitize-schema.js";

/**
 * The MDX safety boundary.
 *
 * An `.mdx` file is compiled and executed as a module. That makes it the one
 * content format that can do real damage, so it is checked before the build
 * rather than trusted: imports, exports, arbitrary components, JavaScript
 * expressions, spread props, event handlers and non-https URLs are all refused.
 *
 * The check parses the file into a real MDX AST. A regular-expression scan
 * would be both easier to fool and harder to explain. An AST validator is what
 * this is, deliberately.
 */

export interface MdxIssue {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

/** Components an `.mdx` file may use, with the attributes each accepts. */
const COMPONENT_SCHEMAS = {
  Callout: z.strictObject({
    type: z.enum(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]),
    title: z.string().min(1).max(120).optional(),
  }),
  Figure: z.strictObject({
    src: z.string(),
    alt: z.string().optional(),
    caption: z.string().optional(),
    credit: z.string().optional(),
    decorative: z.boolean().optional(),
    width: z.number().int().positive().optional(),
    // `Figure.astro` takes a `sizes` hint for figures that do not render at the
    // article column's width — a figure inside a `Gallery` is the case it
    // exists for. The component is the contract, so the schema follows it.
    sizes: z.string().optional(),
  }),
  Gallery: z.strictObject({
    caption: z.string().optional(),
  }),
  Sidenote: z.strictObject({
    label: z.string().min(1).max(120).optional(),
  }),
  VideoEmbed: z.strictObject({
    provider: z.enum(["youtube", "bilibili"]),
    id: z.string(),
    title: z.string().min(1),
    poster: z.string(),
  }),
  AudioPlayer: z.strictObject({
    src: z.string(),
    title: z.string().min(1),
    transcript: z.string().optional(),
  }),
  Tabs: z.strictObject({
    label: z.string().min(1).max(120).optional(),
  }),
  Tab: z.strictObject({
    label: z.string().min(1).max(120),
  }),
  Details: z.strictObject({
    summary: z.string().min(1).max(200),
    open: z.boolean().optional(),
  }),
} as const;

type ComponentName = keyof typeof COMPONENT_SCHEMAS;

const COMPONENT_NAMES = Object.keys(COMPONENT_SCHEMAS) as ComponentName[];

/**
 * Raw HTML an `.mdx` file may contain directly. Deliberately narrower than the
 * Markdown case: an `.mdx` file has components for anything structured, so raw
 * markup is limited to inline semantics.
 */
const ALLOWED_RAW_TAGS = new Set([
  "p",
  "br",
  "em",
  "strong",
  "del",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "hr",
  "abbr",
  "kbd",
  "mark",
  "sup",
  "sub",
  "code",
  "span",
  "div",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

/**
 * Attributes that are never acceptable, whatever the element.
 *
 * Every pattern is case-insensitive on purpose. JSX preserves an attribute's
 * spelling, and a browser reading the resulting HTML matches attribute names
 * case-insensitively, so `onclick`, `onClick` and `ONCLICK` are the same
 * handler. A case-sensitive `/^on[A-Z]/` accepted the first spelling and
 * published the handler into static HTML.
 */
const FORBIDDEN_ATTRIBUTES = [
  /^on[a-z]/iu,
  /^style$/iu,
  /^dangerouslyset/iu,
  /^set:/iu,
  /^client:/iu,
  /^is:/iu,
];

/**
 * Attributes whose value is a URL. Each must be an absolute `https:` URL or a
 * site-absolute path — never `http:`, a document-relative path, or a
 * protocol-relative one.
 */
const URL_ATTRIBUTES = new Set(["src", "href", "poster"]);

const parser = unified().use(remarkParse).use(remarkMdx);

function issueOf(
  message: string,
  node: {
    position?:
      { start?: { line?: number; column?: number } | undefined } | undefined;
  },
): MdxIssue {
  return {
    message,
    line: node.position?.start?.line ?? null,
    column: node.position?.start?.column ?? null,
  };
}

/**
 * Accept an attribute value only when it is a static literal.
 *
 * `title="hello"` is a string. `count={3}` is an expression that must reduce to
 * exactly one ESTree `Literal` — anything involving an identifier, member
 * access, operator, call, template or collection is refused, because those are
 * how an expression becomes code.
 */
function literalValue(
  attribute: MdxJsxAttribute,
  issues: MdxIssue[],
  context: { line: number | null; column: number | null },
): unknown {
  const { value } = attribute;

  if (value === null) return true; // A bare attribute is `true`.
  if (typeof value === "string") return value;

  const expression = value as MdxJsxAttributeValueExpression;
  const body = expression.data?.estree?.body;

  if (body === undefined || body.length !== 1) {
    issues.push({
      ...context,
      message: `Attribute ${attribute.name} must be a single literal value.`,
    });
    return undefined;
  }

  const statement = body[0];
  if (statement === undefined || statement.type !== "ExpressionStatement") {
    issues.push({
      ...context,
      message: `Attribute ${attribute.name} must be a literal, not a statement.`,
    });
    return undefined;
  }

  const expressionNode = statement.expression;
  if (expressionNode.type !== "Literal") {
    issues.push({
      ...context,
      message: `Attribute ${attribute.name} must be a string, number, boolean or null literal; JavaScript expressions are not allowed.`,
    });
    return undefined;
  }

  return expressionNode.value;
}

/**
 * Validate one MDX document. Returns every problem found rather than stopping
 * at the first, so an author can fix a file in one pass.
 */
export function validateMdx(source: string, fileName: string): MdxIssue[] {
  const issues: MdxIssue[] = [];

  let tree: Root;
  try {
    tree = parser.parse(source) as Root;
  } catch (error) {
    return [
      {
        message: `Could not parse ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
        line: null,
        column: null,
      },
    ];
  }

  // --- module-level syntax -------------------------------------------------
  visit(tree, "mdxjsEsm", (node) => {
    issues.push(
      issueOf(
        "import and export statements are not allowed in content; components are provided by the article layout.",
        node,
      ),
    );
  });

  // --- JavaScript expressions ---------------------------------------------
  for (const type of ["mdxFlowExpression", "mdxTextExpression"] as const) {
    visit(tree, type, (node) => {
      // `{' '}` and `{/* comment */}` are formatting, not logic, but separating
      // them from real expressions is not worth the risk of getting it wrong.
      // Authors can write the text directly instead.
      issues.push(
        issueOf(
          "JavaScript expressions are not allowed in content. Write the text directly, or use a whitelisted component.",
          node,
        ),
      );
    });
  }

  // --- components and raw JSX ---------------------------------------------
  for (const type of ["mdxJsxFlowElement", "mdxJsxTextElement"] as const) {
    visit(tree, type, (node) => {
      const name = node.name;

      if (name === null) {
        issues.push(issueOf("JSX fragments are not allowed in content.", node));
        return;
      }

      const isComponent = /^[A-Z]/u.test(name);
      const context = {
        line: node.position?.start.line ?? null,
        column: node.position?.start.column ?? null,
      };

      if (!isComponent) {
        if (!ALLOWED_RAW_TAGS.has(name)) {
          issues.push(
            issueOf(
              `Raw <${name}> is not allowed in MDX content. Use Markdown, or a whitelisted component.`,
              node,
            ),
          );
        }
      } else if (!COMPONENT_NAMES.includes(name as ComponentName)) {
        issues.push(
          issueOf(
            `<${name}> is not a whitelisted component. Allowed: ${COMPONENT_NAMES.join(", ")}.`,
            node,
          ),
        );
        return;
      }

      // --- attributes ------------------------------------------------------
      const collected: Record<string, unknown> = {};

      for (const attribute of node.attributes) {
        if (attribute.type === "mdxJsxExpressionAttribute") {
          issues.push({ ...context, message: "Spread props are not allowed." });
          continue;
        }

        const attributeName = attribute.name;
        if (
          FORBIDDEN_ATTRIBUTES.some((pattern) => pattern.test(attributeName))
        ) {
          issues.push({
            ...context,
            message: `Attribute ${attributeName} is not allowed.`,
          });
          continue;
        }

        const value = literalValue(attribute, issues, context);
        if (value === undefined) continue;

        if (URL_ATTRIBUTES.has(attributeName) && typeof value === "string") {
          // Decided by parsing the value, not by looking at its first
          // characters: `//host/x` and its backslash spelling `/\host/x` are
          // the same URL to a browser, and only the parser knows that.
          const shape = classifyAuthorUrl(value);
          if (shape !== "https" && shape !== "site") {
            issues.push({
              ...context,
              message: `${attributeName} must be an https URL or a site-absolute path.`,
            });
            continue;
          }
        }

        collected[attributeName] = value;
      }

      // --- per-component schema --------------------------------------------
      if (isComponent) {
        const schema = COMPONENT_SCHEMAS[name as ComponentName];
        const result = schema.safeParse(collected);
        if (!result.success) {
          for (const problem of result.error.issues) {
            issues.push({
              ...context,
              message: `<${name}> ${problem.path.join(".") || "props"}: ${problem.message}`,
            });
          }
        }

        const bounds = CHILD_BOUNDS[name];
        if (bounds !== undefined) {
          const count = countChildren(node, bounds.child);
          if (count < bounds.min || count > bounds.max) {
            issues.push({
              ...context,
              message: `<${name}> must contain between ${bounds.min} and ${bounds.max} <${bounds.child}> children, but contains ${count}.`,
            });
          }
        }
      }
    });
  }

  return issues;
}

/**
 * Components that group children, with the number of children they accept.
 *
 * A gallery of one image is not a gallery and a tab strip of one tab has no
 * tabs to move between, so the bound is enforced rather than left as a writing
 * convention. It is checked here, on the AST, because only this pass sees the
 * children.
 */
const CHILD_BOUNDS: Readonly<
  Record<string, { child: string; min: number; max: number }>
> = {
  Gallery: { child: "Figure", min: 2, max: 6 },
  Tabs: { child: "Tab", min: 2, max: 6 },
};

/**
 * Count a component's children of a given name.
 *
 * Counting direct children alone was wrong, and wiring this validator into the
 * release gate is what exposed it: `remark-mdx` decides between
 * `mdxJsxFlowElement` and `mdxJsxTextElement` by where the JSX sits, so
 *
 *     <Tabs>
 *       <Tab label="a">one</Tab>
 *       <Tab label="b">two</Tab>
 *     </Tabs>
 *
 * produced one flow child and one text child wrapped in a paragraph, and a
 * two-tab group was reported as containing a single tab. Author intent does not
 * depend on that detail, so the walk descends through non-JSX containers
 * (paragraphs, lists) and counts every JSX element with the matching name. It
 * does not descend into a JSX element, so a `Tab` nested inside another `Tab`
 * is counted once rather than twice.
 */
function countChildren(
  node: { children?: unknown[] },
  childName: string,
): number {
  let count = 0;

  const walk = (children: readonly unknown[]): void => {
    for (const child of children) {
      if (typeof child !== "object" || child === null) continue;
      const candidate = child as {
        type?: string;
        name?: string;
        children?: unknown[];
      };

      const isJsx =
        candidate.type === "mdxJsxFlowElement" ||
        candidate.type === "mdxJsxTextElement";

      if (isJsx) {
        if (candidate.name === childName) count += 1;
        continue;
      }

      walk(candidate.children ?? []);
    }
  };

  walk(node.children ?? []);
  return count;
}

/** Component names an `.mdx` file is permitted to use. */
export const MDX_COMPONENT_NAMES: readonly string[] = COMPONENT_NAMES;
