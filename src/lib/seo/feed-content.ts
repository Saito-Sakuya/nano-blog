import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";

import { MEDIA_ORIGIN, SITE_URL } from "../site.js";

/**
 * Adapt rendered article HTML for the RSS feed.
 *
 * A feed is not a web page: anything that depends on the site's own scripts,
 * styles or interaction model is either meaningless or a broken promise there.
 * Concretely, three things have to change.
 *
 * - **Sidenotes.** On the site a note floats beside its paragraph and is
 *   numbered in the browser. In a feed there is no float and no script, so each
 *   note becomes a numbered inline remark instead.
 * - **Video embeds.** The player is created on click by a script that will
 *   never run in a reader. The feed keeps the poster, the title and an ordinary
 *   link to the provider — never an iframe.
 * - **Controls.** Copy buttons, heading anchors, the table of contents and the
 *   live region are page chrome. They are removed rather than exported as dead
 *   markup.
 *
 * Every relative URL is rewritten to an absolute one, because a feed is read
 * somewhere else.
 */

/**
 * Elements removed outright, with their contents.
 *
 * The first group drives the page and means nothing in a feed. The second group
 * must never reach a reader: an embedding element in a feed is either dead
 * markup or, in a permissive reader, an actual third-party request the site
 * never agreed to make on the reader's behalf.
 */
const REMOVED_ELEMENTS: readonly string[] = [
  "button",
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "video",
  "canvas",
  // `audio` is deliberately absent: it is real content with a normal download
  // link, it never autoplays, and it contacts no third party.
  "svg",
];

/**
 * Attributes stripped from everything that survives.
 *
 * `target` and `rel` are page-navigation concerns, `data-*` and `class` are the
 * site's own styling hooks, and `id` would collide once several articles appear
 * in one reader.
 */
const STRIPPED_ATTRIBUTES: readonly string[] = [
  "target",
  "rel",
  "class",
  "className",
  "id",
  "tabindex",
  "role",
  "aria-hidden",
  "aria-label",
  "hidden",
  "loading",
  "decoding",
  "fetchpriority",
  "data-pagefind-meta",
  "data-pagefind-body",
];

function hasClass(node: Element, name: string): boolean {
  const value = node.properties?.["className"];
  return Array.isArray(value) && value.some((entry) => entry === name);
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** Rewrite a site-relative URL to an absolute one. */
function absolute(href: string): string {
  if (href.startsWith("/media/")) return `${MEDIA_ORIGIN}${href}`;
  if (href.startsWith("/")) return `${SITE_URL}${href}`;
  return href;
}

export function toFeedHtml(html: string): string {
  const tree = fromHtml(html, { fragment: true }) as Root;

  // --- controls, chrome and embedding elements -----------------------------
  for (const tagName of REMOVED_ELEMENTS) {
    visit(tree, "element", (node: Element, index, parent) => {
      if (
        node.tagName !== tagName ||
        parent === undefined ||
        index === undefined
      )
        return;
      parent.children.splice(index, 1);
      return index;
    });
  }

  // A heading anchor is an empty link to a fragment. In a feed it is a dead
  // control pointing at a URL that is not absolute, so it goes.
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "a" || parent === undefined || index === undefined)
      return;
    if (!hasClass(node, "heading-anchor")) return;
    parent.children.splice(index, 1);
    return index;
  });

  // --- sidenotes -----------------------------------------------------------
  let sidenoteNumber = 0;
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "aside" || !hasClass(node, "sidenote")) return;
    if (parent === undefined || index === undefined) return;

    sidenoteNumber += 1;
    const body = node.children.filter(
      (child) =>
        !(child.type === "element" && hasClass(child, "sidenote__marker")),
    );

    const replacement: Element = {
      type: "element",
      tagName: "p",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "strong",
          properties: {},
          children: [{ type: "text", value: `〔边注 ${sidenoteNumber}〕` }],
        },
        { type: "text", value: " " },
        ...body,
      ],
    };

    parent.children[index] = replacement;
  });

  // --- video embeds --------------------------------------------------------
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "figure" || !hasClass(node, "embed")) return;
    if (parent === undefined || index === undefined) return;

    const caption = node.children.find(
      (child): child is Element =>
        child.type === "element" && child.tagName === "figcaption",
    );
    const poster = findPoster(node);
    const link = caption === undefined ? undefined : findExternalLink(caption);
    const title = caption === undefined ? "视频" : textOf(caption).trim();

    const children: ElementContent[] = [];
    if (poster !== undefined) children.push(poster);
    children.push({
      type: "element",
      tagName: "p",
      properties: {},
      children: [
        { type: "text", value: title.length > 0 ? `${title} ` : "" },
        ...(link === undefined
          ? []
          : [
              {
                type: "element" as const,
                tagName: "a",
                properties: { href: link },
                children: [{ type: "text" as const, value: "前往观看" }],
              },
            ]),
      ],
    });

    parent.children[index] = {
      type: "element",
      tagName: "figure",
      properties: {},
      children,
    };
  });

  // --- page-only attributes ------------------------------------------------
  visit(tree, "element", (node: Element) => {
    if (node.properties === undefined) return;
    for (const name of STRIPPED_ATTRIBUTES) {
      delete node.properties[name];
    }
    for (const name of Object.keys(node.properties)) {
      if (name.startsWith("data")) delete node.properties[name];
    }
  });

  // --- absolute URLs -------------------------------------------------------
  visit(tree, "element", (node: Element) => {
    for (const property of ["href", "src"] as const) {
      const value = node.properties?.[property];
      if (typeof value === "string") {
        node.properties[property] = absolute(value);
      }
    }
  });

  return toHtml(tree);
}

function findPoster(figure: Element): Element | undefined {
  let found: Element | undefined;
  visit(figure, "element", (node: Element) => {
    if (found !== undefined) return;
    if (node.tagName === "img") found = node;
  });
  return found;
}

function findExternalLink(node: Element): string | undefined {
  let href: string | undefined;
  visit(node, "element", (child: Element) => {
    if (href !== undefined) return;
    if (child.tagName !== "a") return;
    const value = child.properties?.["href"];
    if (typeof value === "string") href = value;
  });
  return href;
}
