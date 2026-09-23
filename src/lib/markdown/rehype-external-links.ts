import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Mark links that leave the site.
 *
 * External links open in the current tab, deliberately; the
 * only thing added is a screen-reader-only note and a class the stylesheet uses
 * for the small external glyph. No `target="_blank"` is introduced here — only
 * the site's own generated video fallbacks may ask for a new window.
 */
export function rehypeExternalLinks(options: { siteOrigin: string }) {
  const { siteOrigin } = options;

  return (tree: Root): void => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;

      const href = node.properties?.href;
      if (typeof href !== "string") return;

      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return; // Relative, fragment or mailto: not an external web link.
      }

      if (url.origin === siteOrigin) return;

      node.properties = node.properties ?? {};
      const existing = node.properties.className;
      node.properties.className = Array.isArray(existing)
        ? [...existing, "link--external"]
        : ["link--external"];

      node.children.push({
        type: "element",
        tagName: "span",
        properties: { className: ["sr-only"] },
        children: [{ type: "text", value: "（外部链接）" }],
      });
    });
  };
}
