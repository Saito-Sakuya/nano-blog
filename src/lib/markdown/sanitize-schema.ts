import type { Schema } from "hast-util-sanitize";
import { defaultSchema } from "hast-util-sanitize";

import { SITE_URL } from "../site.js";

/**
 * The whitelist applied to HTML an author writes directly in Markdown.
 *
 * This schema governs *author input only*. It is applied at the remark stage,
 * before `remark-rehype` runs and long before Shiki, KaTeX or the heading
 * slugger exist in the tree. Nothing a trusted plugin generates is ever passed
 * through it, which is why this schema can stay genuinely narrow: it never has
 * to permit the `class`, `style`, `id` or MathML that those plugins emit.
 *
 * Anything not listed here is removed, including `<script>`, `<style>`,
 * `<iframe>`, `<object>`, `<embed>`, `<form>` and SVG.
 */

/** Elements an author may write directly in Markdown. */
const AUTHOR_TAG_NAMES = [
  "a",
  "abbr",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "em",
  "figcaption",
  "figure",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "strong",
  "sub",
  "summary",
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
 * Elements removed together with their children. `<template>` and `<noscript>`
 * are included because their contents are not rendered as normal flow content
 * and are a common way to smuggle markup past a naive cleaner.
 */
const STRIPPED_TAG_NAMES = [
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
  "link",
  "math",
  "meta",
  "noscript",
  "object",
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

export const authorHtmlSchema: Schema = {
  ...defaultSchema,
  tagNames: [...AUTHOR_TAG_NAMES],
  strip: [...STRIPPED_TAG_NAMES],
  // No author-supplied `id` or `name` is allowed, so there is nothing for a
  // clobbering prefix to protect. Keeping it off avoids surprising renames.
  clobberPrefix: "",
  attributes: {
    a: ["href", "title"],
    abbr: ["title"],
    // Authors may set intrinsic size and lazy-loading hints, but never a class,
    // style, event handler or arbitrary data attribute.
    img: ["src", "alt", "width", "height", "loading", "decoding"],
    input: [["type", "checkbox"], "checked", "disabled"],
    li: ["value"],
    ol: ["start", "reversed", "type"],
    // `class` is deliberately absent even here: Shiki adds its own classes
    // after this pass, and the language of a fence is carried separately.
    code: [],
    pre: [],
    td: ["colspan", "rowspan", "headers", "align"],
    th: ["colspan", "rowspan", "headers", "scope", "align"],
    details: ["open"],
    del: ["cite"],
    blockquote: ["cite"],
  },
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
    cite: ["http", "https"],
  },
  required: {
    input: { type: "checkbox", disabled: true },
  },
};

/** Protocols an author-written URL may name explicitly. */
const ALLOWED_ABSOLUTE_SCHEMES: ReadonlyMap<string, AuthorUrlShape> = new Map([
  ["https:", "https"],
  ["http:", "http"],
  ["mailto:", "mailto"],
]);

/**
 * Every C0 control character and DEL.
 *
 * The WHATWG URL parser removes tab, LF and CR *before* parsing, so
 * `/<tab>/evil.example` is read as the protocol-relative `//evil.example` while
 * looking like a site-absolute path. Refusing control characters outright keeps
 * the value and the parsed form describing the same thing.
 */
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** An explicit scheme at the start of the value, if there is one. */
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** The origin a page-relative URL resolves against. */
function siteOrigin(): string {
  try {
    return new URL(SITE_URL).origin;
  } catch {
    // An unusable `SITE_URL` must not become a wildcard: with no origin to
    // compare against, nothing that resolves relatively can be called safe.
    return "";
  }
}

const SITE_ORIGIN = siteOrigin();

/**
 * The shape of an author-written URL.
 *
 * - `https`, `http`, `mailto` — an explicit URL with one of the allowed
 *   schemes, which the browser will take as written.
 * - `site` — a site-absolute path such as `/posts/`.
 * - `relative` — a document-relative path, which resolves on this origin.
 * - `unsafe` — everything else: a forbidden scheme (`javascript:`, `data:`,
 *   `vbscript:`, `file:`, `blob:`), an unparsable value, a control character,
 *   or a reference that resolves to *another* origin.
 */
export type AuthorUrlShape =
  "https" | "http" | "mailto" | "site" | "relative" | "fragment" | "unsafe";

/**
 * Classify a URL the way a browser would resolve it.
 *
 * The value is parsed with `new URL(value, SITE_URL)` — the same algorithm the
 * browser uses when it follows the link — rather than inspected character by
 * character. That is what makes the protocol-relative forms detectable:
 * `//evil.example/x`, `/\evil.example/x` and `/<tab>/evil.example` are three
 * spellings of one URL whose authority is not this site, and only the parser
 * knows that all three resolve to `https://evil.example`.
 */
export function classifyAuthorUrl(value: string): AuthorUrlShape {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unsafe";
  if (URL_CONTROL_CHARACTERS.test(trimmed)) return "unsafe";

  let resolved: URL;
  try {
    resolved = new URL(trimmed, SITE_URL);
  } catch {
    return "unsafe";
  }

  if (EXPLICIT_SCHEME.test(trimmed)) {
    return ALLOWED_ABSOLUTE_SCHEMES.get(resolved.protocol) ?? "unsafe";
  }

  // Without a scheme the value resolves against the page it was written on, so
  // it must land on this origin. `//host/x` reaches this point scheme-less and
  // fails here: the parser read an authority out of it, and that authority is
  // not this site's.
  if (resolved.origin !== SITE_ORIGIN) return "unsafe";
  if (trimmed.startsWith("/")) return "site";
  return trimmed.startsWith("#") ? "fragment" : "relative";
}

/**
 * True when an author-written URL may survive into the rendered page.
 *
 * `hast-util-sanitize` already drops absolute URLs whose protocol is not in the
 * allow-list, but it treats a protocol-relative URL such as `//example.invalid/x`
 * as a harmless relative path. On a live site that resolves to an external
 * origin, so it is rejected here — along with the backslash and tab spellings
 * of the same thing, which no character-by-character check would catch.
 */
export function isSafeAuthorUrl(value: string): boolean {
  return classifyAuthorUrl(value) !== "unsafe";
}
