import { fromHtml } from "hast-util-from-html";
import { sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import type { Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import { SKIP, visit } from "unist-util-visit";

import { authorHtmlSchema, isSafeAuthorUrl } from "./sanitize-schema.js";

/**
 * Clean raw HTML an author wrote in a Markdown file.
 *
 * Why this runs as a *remark* plugin rather than a rehype one:
 *
 * Astro 7 builds the Markdown pipeline in a fixed order — user rehype plugins
 * run after `rehypeShiki` but before `rehypeRaw`. Two consequences follow.
 * Putting a sanitizer in `rehypePlugins` would (a) strip the `class` and inline
 * `style` that Shiki had just emitted, and (b) be useless as a defence, because
 * the author's HTML is still an unparsed `raw` node at that point and only
 * becomes real elements later, in `rehypeRaw`.
 *
 * Sanitising here, on the mdast `html` nodes, means the dangerous markup is
 * gone before `remark-rehype` and `rehypeRaw` ever see it, and the trusted
 * output of Shiki, KaTeX and the heading slugger is never touched.
 */
export function remarkSanitizeHtml() {
  return (tree: MdastRoot): void => {
    visit(tree, "html", (node, index, parent) => {
      const cleaned = sanitizeHtmlFragment(node.value);
      if (cleaned !== null) {
        node.value = cleaned;
        return;
      }

      /*
       * Fail closed.
       *
       * A fragment that could not be parsed is a fragment whose safety nobody
       * has established, so it does not reach the renderer at all. Keeping the
       * original — which is what this used to do — meant the one input the
       * sanitiser could not handle was also the one input it passed through
       * untouched.
       */
      if (parent === undefined || index === undefined) {
        node.value = "";
        return;
      }
      parent.children.splice(index, 1);
      return [SKIP, index];
    });
  };
}

/**
 * Sanitise one HTML fragment. Returns `null` when the fragment could not be
 * parsed; the plugin then removes the node entirely rather than passing
 * something unvetted through to the renderer.
 */
function sanitizeHtmlFragment(html: string): string | null {
  let parsed: HastRoot;
  try {
    parsed = fromHtml(html, { fragment: true });
  } catch {
    return null;
  }

  const clean = sanitize(parsed, authorHtmlSchema);
  // `hast-util-sanitize` is typed as returning any `Nodes`, but a root goes in
  // and a root comes out; the assertion is checked by the runtime guard below.
  if (clean.type !== "root") {
    throw new Error("Sanitising an HTML fragment did not return a root node.");
  }
  removeUnsafeUrls(clean);
  return toHtml(clean, { allowDangerousHtml: false });
}

/**
 * Walk the sanitised tree and drop any `href`/`src`/`cite` that survived the
 * schema but is still not an acceptable destination.
 */
function removeUnsafeUrls(root: HastRoot): void {
  visit(root, "element", (node) => {
    for (const property of ["href", "src", "cite"] as const) {
      const value = node.properties[property];
      if (typeof value !== "string") continue;
      if (!isSafeAuthorUrl(value)) {
        delete node.properties[property];
      }
    }
  });
}
