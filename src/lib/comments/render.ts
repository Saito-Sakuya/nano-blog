import { toHtml } from "hast-util-to-html";
import { sanitize, type Schema } from "hast-util-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Rendering an untrusted comment to HTML.
 *
 * ## The shape of the pipeline, and why
 *
 * The author-content pipeline in `src/lib/markdown/` is the wrong tool here, for
 * two independent reasons:
 *
 * 1. It is built for trusted input. Its sanitiser runs at the *mdast* stage, on
 *    `html` nodes only, which is correct for an author whose links are checked
 *    by the publish gate (`scripts/content/validate.ts` allows https links only)
 *    and whose body is reviewed. A comment arrives with no gate in front of it.
 * 2. It carries Shiki, KaTeX, Mermaid, heading anchors and callouts. None of
 *    those belong in a comment, and Shiki alone would mean loading a grammar
 *    engine to render two paragraphs.
 *
 * So this is a small pipeline of its own:
 *
 * ```
 * remark-parse → remark-gfm → remark-rehype → sanitize → toHtml
 * ```
 *
 * `remark-rehype` is called **without** `allowDangerousHtml`, which is the first
 * and most important decision here: raw HTML in the markdown is not passed
 * through as nodes, it becomes literal text. `<script>alert(1)</script>` typed
 * into a comment renders as those characters, visibly. That is stricter than
 * sanitising it away, and it means the sanitiser is a second line of defence
 * rather than the only one.
 *
 * ## The gap that the sanitiser does not close
 *
 * `hast-util-sanitize` filters **HTML nodes**. A markdown link's destination is
 * not a node — `remark-rehype` turns `[x](javascript:alert(1))` into a real
 * `<a href="javascript:alert(1)">` *before* the sanitiser sees it, and the
 * default schema's `protocols` handling only applies to attributes it is asked
 * to check on elements it recognises. A link written as markdown therefore
 * bypasses a naively-configured sanitiser.
 *
 * `COMMENT_SCHEMA.protocols` below is what closes it, and it is the reason this
 * module cannot simply reuse `authorHtmlSchema`: that schema allows `mailto:` and
 * is paired with a publish-time gate that a comment never passes through.
 *
 * `tests/unit/comments-render.test.ts` contains the vectors — `javascript:`,
 * `data:`, `vbscript:`, protocol-relative and obfuscated spellings — and fails
 * if any of them survives.
 */

/**
 * Elements a comment may contain. No images, no headings.
 *
 * Tables are included because `remark-gfm` parses them anyway, and leaving the
 * elements out does not remove a table — the sanitiser dissolves it and the
 * reader gets the cells as a run of loose text with the line breaks flattened
 * out. Rendering the table properly is both the honest outcome and the less
 * surprising one.
 */
const COMMENT_TAG_NAMES = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

/**
 * Elements removed together with their children.
 *
 * `img` is here rather than merely absent from the allow-list because a remote
 * image in a comment is a tracking pixel: it reports the reader's IP address and
 * user agent to whoever wrote the comment, on every page view, without the
 * reader doing anything. The site proxies avatars for exactly this reason; a
 * comment body must not reintroduce the same leak.
 */
const COMMENT_STRIPPED_TAG_NAMES = [
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "picture",
  "script",
  "select",
  "slot",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
] as const;

/**
 * The schema applied to a rendered comment.
 *
 * Stricter than the author schema in every direction: no images, no checkboxes,
 * no `mailto:`, and no attributes beyond a link's `href` and `title`. `class`,
 * `style`, `id` and `data-*` are absent, so they are removed — the stylesheet
 * styles comment prose by element, not by a class an attacker could borrow.
 */
export const COMMENT_SCHEMA: Schema = {
  tagNames: [...COMMENT_TAG_NAMES],
  strip: [...COMMENT_STRIPPED_TAG_NAMES],
  clobberPrefix: "",
  attributes: {
    a: ["href", "title"],
    code: [],
    pre: [],
    li: ["value"],
    ol: ["start", "reversed", "type"],
    blockquote: [],
    del: [],
    td: ["colspan", "rowspan", "align"],
    th: ["colspan", "rowspan", "align", "scope"],
  },
  protocols: {
    // http and https only. `mailto` is deliberately excluded: an address in a
    // comment body is a written address, and making it clickable only creates a
    // harvesting surface.
    href: ["http", "https"],
    src: [],
    cite: [],
  },
};

const FORBIDDEN_URL = /^(?:javascript|data|vbscript|file|blob):/iu;

/**
 * Reject a URL that must never appear in a comment.
 *
 * Applied *after* sanitising, to every `href` in the tree. `hast-util-sanitize`
 * drops attributes whose protocol is not allowed, but it treats `//example.invalid`
 * as a relative path and it can be defeated by spellings such as
 * `java\tscript:` that the URL parser normalises and a regex does not. Checking
 * the final tree catches what the schema misses.
 */
function isSafeCommentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // A protocol-relative URL resolves to an external origin on a live site.
  if (trimmed.startsWith("//")) return false;
  if (FORBIDDEN_URL.test(trimmed)) return false;
  // Strip tabs, newlines and leading control characters before re-testing, so
  // `java\tscript:` cannot slip past the check above.
  const flattened = trimmed.replace(/[\u0000-\u0020]/gu, "").toLowerCase();
  if (flattened.startsWith("javascript:") || flattened.startsWith("data:")) {
    return false;
  }
  if (flattened.startsWith("vbscript:") || flattened.startsWith("blob:")) {
    return false;
  }
  return true;
}

/**
 * Turn raw HTML nodes into literal text.
 *
 * Without this, `remark-rehype` (called without `allowDangerousHtml`) *drops*
 * every html node — and dropping is not a neutral choice. It silently eats the
 * reader's words: `<style>x</style>hello` renders as nothing at all, and
 * `Array<string> is a type` renders as `Array is a type`, which on a technical
 * blog is a sentence someone would actually write and would not understand
 * losing. Odd as it looks, `<string>` is a valid tag name as far as the parser
 * is concerned.
 *
 * Converting the node to text keeps the content and keeps it safe: the output
 * stage escapes it, so the reader sees the characters they typed and the browser
 * sees no markup to act on. The rule a commenter has to learn is a simple one —
 * *HTML you type is shown, not rendered* — and it is the same rule that makes
 * the whole pipeline safe, rather than a second mechanism bolted beside it.
 *
 * This runs before `remark-rehype`, so by the time the sanitiser is reached
 * there is no raw HTML left to sanitise. The sanitiser stays as the second line
 * of defence for everything the markdown parser itself produces.
 */
function remarkRawHtmlAsText() {
  return (tree: unknown): void => {
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const container = node as {
        children?: unknown[];
        type?: string;
        value?: string;
      };

      if (Array.isArray(container.children)) {
        container.children = container.children.map((child) => {
          if (
            child !== null &&
            typeof child === "object" &&
            (child as { type?: string }).type === "html"
          ) {
            const value = (child as { value?: string }).value ?? "";
            return { type: "text", value };
          }
          walk(child);
          return child;
        });
      }
    };

    walk(tree);
  };
}

/** Remove every unsafe link destination from a sanitised tree. */
function dropUnsafeUrls(node: unknown): void {
  if (node === null || typeof node !== "object") return;

  const element = node as {
    type?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: unknown[];
  };

  if (element.type === "element" && element.properties !== undefined) {
    for (const key of ["href", "src", "cite"] as const) {
      const value = element.properties[key];
      if (typeof value === "string" && !isSafeCommentUrl(value)) {
        delete element.properties[key];
      }
    }
  }

  if (Array.isArray(element.children)) {
    for (const child of element.children) dropUnsafeUrls(child);
  }
}

/**
 * Render comment markdown to safe HTML.
 *
 * Synchronous, because every plugin in the chain is: `remark-parse`,
 * `remark-gfm`, `remark-rehype`, `hast-util-sanitize` and `hast-util-to-html`
 * are all plain transforms with no I/O. That matters for the edge runtime, where
 * a synchronous render inside a request handler avoids nothing dire but keeps the
 * whole function easy to reason about.
 */
export function renderCommentMarkdown(markdown: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRawHtmlAsText)
    // `allowDangerousHtml` is NOT set either: after the transform above there
    // should be no html node left, and this makes sure that if one ever appears
    // it is dropped rather than passed through.
    .use(remarkRehype);

  const mdast = processor.parse(markdown);
  const hast = processor.runSync(mdast);

  /*
   * `sanitize` mutates and returns the tree, so the cast is to the generic node
   * shape the walker expects. The tree came out of this function one line ago,
   * so its shape is known.
   */
  const cleaned = sanitize(hast, COMMENT_SCHEMA) as unknown as {
    children?: unknown[];
  };
  dropUnsafeUrls(cleaned);

  return toHtml(cleaned as Parameters<typeof toHtml>[0], {
    // Nothing should remain, but allowing dangerous HTML on output would undo
    // the entire point of the pipeline if something did.
    allowDangerousHtml: false,
  });
}
