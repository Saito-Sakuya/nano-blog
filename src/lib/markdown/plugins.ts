import { unified } from "@astrojs/markdown-remark";
import rehypeKatex from "rehype-katex";
import remarkDirective from "remark-directive";
import remarkMath from "remark-math";

import { SITE_URL } from "../site.js";
import { rehypeExternalLinks } from "./rehype-external-links.js";
import { rehypeCodeBlocks } from "./rehype-code-blocks.js";
import { rehypeMermaid } from "./rehype-mermaid.js";
import { rehypeTaskList } from "./rehype-task-list.js";
import { remarkCallouts } from "./remark-callouts.js";
import { remarkCodeMeta } from "./remark-code-meta.js";
import { remarkHeadingAnchors } from "./remark-heading-anchors.js";
import { remarkSanitizeHtml } from "./remark-sanitize-html.js";
import { remarkSidenotes } from "./remark-sidenotes.js";
import { transformerCodeMeta } from "./shiki-transformer.js";

/**
 * Build the Markdown processor for the whole site.
 *
 * Astro 7 defaults to Sätteri, its native pipeline. This site needs the
 * remark/rehype ecosystem — `remark-math` for KaTeX, `remark-directive` for
 * sidenotes, and the AST-level HTML sanitizer — so it opts back into the
 * unified pipeline explicitly with `unified()`.
 *
 * Pipeline order is fixed by Astro and matters a great deal here:
 *
 *   remark  : gfm → smartypants → [these plugins] → remark-rehype
 *   rehype  : shiki → [these plugins] → heading ids → raw HTML → stringify
 *
 * Because Shiki and `rehypeRaw` both run after the user rehype plugins, the
 * author-HTML sanitizer lives on the *remark* side (see
 * `remark-sanitize-html.ts`) and code-block decoration is done by a Shiki
 * transformer rather than a rehype plugin.
 */
export function createMarkdownProcessor() {
  return unified({
    /*
     * Footnotes are the one piece of chrome the Markdown pipeline generates on
     * its own, and its defaults are English: the section reads "Footnotes" and
     * each return link is announced as "Back to reference N". On a `zh-CN` site
     * that is both visibly wrong and an unclear name for assistive technology,
     * so the labels are set here rather than left to the library.
     */
    remarkRehype: {
      footnoteLabel: "脚注",
      footnoteBackLabel: "返回引用",
    },
    // Each entry is an *attacher* — a function unified calls with the plugin's
    // options, whose return value becomes the tree transformer. Calling one of
    // these factories here would hand unified a transformer instead, and it
    // would then be invoked with `undefined` in place of the tree.
    remarkPlugins: [
      remarkMath,
      remarkDirective,
      remarkCallouts,
      remarkSidenotes,
      remarkHeadingAnchors,
      remarkCodeMeta,
      // Must run last among the remark plugins so it cleans the author's raw
      // HTML after the plugins above have finished rewriting the tree.
      remarkSanitizeHtml,
    ],
    rehypePlugins: [
      // Renders KaTeX from the `math` nodes `remark-math` produced. Runs after
      // Shiki, which is harmless: maths is not a highlighted language.
      rehypeKatex,
      // Wraps Shiki's bare `<pre>` in the frame that carries the language
      // label, the title and the copy button that `article.ts` wires up.
      rehypeCodeBlocks,
      // Mermaid blocks keep their source in the document, so this runs after
      // KaTeX has finished and simply reshapes an untouched `<pre>`.
      rehypeMermaid,
      // Names the checkboxes `remark-gfm` emits for task lists.
      rehypeTaskList,
      [rehypeExternalLinks, { siteOrigin: SITE_URL }],
    ],
  });
}

/** Shiki settings shared by every Markdown and MDX document. */
export const shikiConfig = {
  // A single built-in dark theme, matching the dark code surface used by both
  // page themes. Code blocks are dark in light mode too, by design.
  theme: "github-dark",
  transformers: [transformerCodeMeta()],
} as const;

/**
 * Languages Shiki must leave alone.
 *
 * `mermaid` blocks keep their raw source so the client-side renderer has
 * something to read, and so the no-JavaScript fallback shows the diagram
 * source instead of an empty highlighted box. `math` is Astro's own default
 * exclusion and is kept for the same reason.
 */
export const shikiExcludeLangs = ["math", "mermaid"];
