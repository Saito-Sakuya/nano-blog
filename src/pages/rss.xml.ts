import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";

import { loadSite } from "../lib/content/collections.js";
import { toFeedHtml } from "../lib/seo/feed-content.js";
import {
  CONTENT_LICENSE_LABEL,
  CONTENT_LICENSE_URL,
  MEDIA_ORIGIN,
  SITE_NAME,
  SITE_TAGLINE,
  canonicalUrl,
} from "../lib/site.js";

/**
 * The full-text feed.
 *
 * Full text, not a teaser: the feed is a first-class way to read this site, so
 * an article arrives complete. It contains only published posts — no pages, no
 * drafts, no future-dated articles — ordered newest first, which is the same
 * visibility rule every other surface uses.
 *
 * Every item carries the article's canonical link, its publication date, its
 * update date when it has one, its tags, its cover and the licence. The body
 * HTML comes from the article's own rendering and is adapted by `toFeedHtml`,
 * which is where the page-only affordances (sidenotes, video embeds, controls)
 * are turned into something a reader can actually display.
 *
 * The cover is expressed as a `media:thumbnail`, not as an RSS `enclosure`: an
 * enclosure is a media attachment with a byte length, and inventing a length
 * for an image that was never measured would be publishing a false fact about
 * it. The same image is also the first element of the item's content, so a
 * reader that shows images has one whether or not it understands Media RSS.
 *
 * `atom:updated` carries the revision date because RSS 2.0 has no element for
 * it; readers that ignore unknown extensions simply see the publication date.
 */

const MEDIA_NAMESPACE = "http://search.yahoo.com/mrss/";
const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";

function escapeText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/gu, "&quot;");
}

/**
 * Classes that must not survive into the feed.
 *
 * A heading's permalink anchor is an empty `<a>` whose visual `#` is drawn by
 * the site's stylesheet and whose `href` is a bare fragment. In a feed it is
 * an empty element pointing at nothing, and a fragment is not an absolute URL,
 * so it is dropped rather than exported as a working-looking dead control.
 */
const DROPPED_FEED_CLASSES: ReadonlySet<string> = new Set(["heading-anchor"]);

/*
 * The HTML AST types are published as `@types/hast`, which is not resolvable
 * from application code in this workspace, so they are derived from the two
 * libraries that produce and consume the tree rather than naming the module.
 */
type HastRoot = ReturnType<typeof fromHtml>;
type HastContent = HastRoot["children"] extends readonly (infer Item)[]
  ? Item
  : never;
type HastElement = Extract<HastContent, { type: "element" }>;

/** Elements that may not legally appear inside a paragraph. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "dl",
  "figure",
  "figcaption",
  "blockquote",
  "pre",
  "table",
  "section",
  "aside",
  "details",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** Elements that carry no meaning once they hold nothing. */
const EMPTIABLE_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "span",
  "div",
  "strong",
  "em",
]);

/** An element's classes. The HTML parser always normalises them into a list. */
function classNames(node: HastElement): string[] {
  return node.properties["className"] ?? [];
}

function textOf(node: HastElement): string {
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element") text += textOf(child);
  }
  return text.trim();
}

function isEmpty(node: HastElement): boolean {
  if (!EMPTIABLE_ELEMENTS.has(node.tagName)) return false;
  if (textOf(node).length > 0) return false;
  return node.children.every(
    (child) => child.type !== "element" || isEmpty(child),
  );
}

/**
 * The final pass over an article body before it goes into the feed.
 *
 * It removes the heading anchors described above, drops elements left holding
 * nothing, and repairs one structural problem: a note that carries block
 * content can end up inside the paragraph that introduces it, and a `<p>` may
 * not contain a `<p>` or a list. Nesting that is illegal is what makes a
 * reader guess at the intended structure, so any paragraph still holding a
 * block element is retagged as a `<div>` — the same content, legally nested.
 */
function toFeedBody(html: string): string {
  if (html === "") return "";

  const tree: HastRoot = fromHtml(html, { fragment: true });
  normalise(tree);
  return toHtml(tree);
}

function normalise(node: HastRoot | HastElement): void {
  const kept: HastContent[] = [];

  for (const child of node.children as readonly HastContent[]) {
    if (child.type === "element") {
      if (classNames(child).some((name) => DROPPED_FEED_CLASSES.has(name)))
        continue;

      normalise(child);
      if (isEmpty(child)) continue;

      if (
        child.tagName === "p" &&
        child.children.some(
          (grandchild) =>
            grandchild.type === "element" &&
            BLOCK_ELEMENTS.has(grandchild.tagName),
        )
      ) {
        child.tagName = "div";
      }
    }

    kept.push(child);
  }

  (node as { children: HastContent[] }).children = kept;
}

export const GET: APIRoute = async () => {
  const site = await loadSite();
  const entries = await getCollection("posts");

  /*
   * `entry.rendered.html` is populated for Markdown but not for MDX: an MDX
   * document compiles to a component rather than to a string.
   *
   * KNOWN LIMITATION — `.mdx` articles therefore appear in the feed with their
   * title, description, dates, tags, cover and licence, but without their body
   * text. Two routes were tried to close this and neither is usable here:
   *
   *   1. `experimental_AstroContainer.renderToString(Content)` fails with
   *      `NoMatchingRenderer` — the container has no MDX renderer by default.
   *   2. Registering one via `@astrojs/mdx/container-renderer` crashes the
   *      build outright.
   *
   * Rather than ship a feed that silently claims a body it does not have, the
   * count of affected documents is reported below, so the gap is visible in
   * every build log until it is closed.
   */
  const htmlById = new Map<string, string>();
  const withoutBody: string[] = [];

  for (const entry of entries) {
    const html = entry.rendered?.html;
    if (html === undefined || html === "") {
      withoutBody.push(entry.id);
      continue;
    }
    htmlById.set(entry.id, toFeedBody(toFeedHtml(html)));
  }

  if (withoutBody.length > 0) {
    console.warn(
      `rss: ${withoutBody.length} document(s) have no rendered HTML and appear in the feed without a body: ${withoutBody.join(", ")}`,
    );
  }

  return rss({
    title: SITE_NAME,
    description: SITE_TAGLINE,
    site: `${canonicalUrl("/")}`.replace(/\/$/u, ""),
    trailingSlash: true,
    xmlns: {
      media: MEDIA_NAMESPACE,
      atom: ATOM_NAMESPACE,
    },
    customData:
      "<language>zh-CN</language>" +
      `<copyright>内容采用 ${CONTENT_LICENSE_LABEL}，代码采用 MIT。</copyright>`,
    items: site.posts.map((post) => {
      const cover = post.data.cover;
      const coverUrl = `${MEDIA_ORIGIN}${cover.src}`;

      const content: string[] = [];
      content.push(
        `<figure><img src="${escapeAttribute(coverUrl)}" alt="${escapeAttribute(cover.alt)}"` +
          ` width="${cover.width}" height="${cover.height}" />`,
      );
      if (cover.credit !== undefined) {
        content.push(`<figcaption>${escapeText(cover.credit)}</figcaption>`);
      }
      content.push("</figure>");

      const body = htmlById.get(post.id);
      if (body !== undefined) content.push(body);

      content.push(
        `<p>本文采用 <a href="${CONTENT_LICENSE_URL}">${CONTENT_LICENSE_LABEL}</a> 许可。</p>`,
      );

      const customData = [
        `<media:thumbnail url="${escapeAttribute(coverUrl)}" />`,
      ];
      if (post.data.updatedAt !== undefined) {
        customData.push(`<atom:updated>${post.data.updatedAt}</atom:updated>`);
      }

      return {
        title: post.data.ogTitle ?? post.data.title,
        description: post.data.ogDescription ?? post.data.description,
        link: post.url,
        pubDate: new Date(post.data.publishedAt),
        categories: post.data.tags.map((tag) => tag.label),
        content: content.join("\n"),
        customData: customData.join(""),
      };
    }),
  });
};
