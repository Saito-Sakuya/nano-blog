import type { Heading, Link, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

import { createHeadingSlugger } from "./slug.js";

/**
 * Give every heading a stable `id` and an inline anchor link.
 *
 * Astro's own `rehypeHeadingIds` pass runs late in the pipeline, but it leaves
 * an `id` alone when one is already present while still collecting the heading
 * into the entry's `headings` array. Setting the id here therefore does two
 * things at once: it applies this site's own slug rules (which Astro's
 * `github-slugger` default does not match for Chinese headings), and it still
 * produces the table of contents that `render()` hands to the article page.
 *
 * The anchor carries no text of its own. The visual `#` is drawn with CSS, so
 * the glyph never leaks into the heading text that other passes extract.
 */
export function remarkHeadingAnchors() {
  return (tree: Root): void => {
    const slug = createHeadingSlugger();

    visit(tree, "heading", (node: Heading) => {
      if (node.depth === 1) {
        throw new Error(
          "An H1 appears in the body of a document. The article title is the only H1; " +
            "start body headings at H2.",
        );
      }

      const text = toString(node);
      const id = slug(text);

      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          id,
        },
      };

      const anchor: Link = {
        type: "link",
        url: `#${id}`,
        title: null,
        data: {
          hProperties: {
            className: ["heading-anchor"],
            ariaLabel: "复制本节链接",
            dataHeadingAnchor: id,
          },
        },
        children: [],
      };

      node.children.push(anchor);
    });
  };
}
