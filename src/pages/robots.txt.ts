import type { APIRoute } from "astro";

import { SITE_URL, isIndexable } from "../lib/site.js";

/**
 * `robots.txt`.
 *
 * The only thing that decides what this file says is `SITE_ENV`, read through
 * `isIndexable()`. A local or preview build forbids crawling outright — the
 * preview host is a real, reachable origin, and letting a search engine index
 * it would put a second copy of every article on the web. Only the production
 * build allows crawling, and only it advertises the sitemap, so a preview can
 * never point a crawler at URLs that belong to the live domain.
 *
 * `robotsTxt` is exported so the production branch can be asserted without
 * mutating the build environment: `isIndexable()` reads `SITE_ENV` once, at
 * module load, and the only other way to reach this text would be to re-import
 * the module with a different environment.
 */

/** Paths that answer with something other than public content. */
const DISALLOWED_PATHS = [
  // The comment and view endpoints. They are POST-only, or per-article, and a
  // crawler that follows one has found a JSON body rather than a page.
  "/api/",
  // The closed-comments manifest, which exists for the endpoint above and is
  // fetched by it. It is public in the sense that it is served, and it is still
  // nothing a search result should point at.
  "/comments-closed.json",
];

export function robotsTxt(indexable: boolean): string {
  if (!indexable) {
    return ["User-agent: *", "Disallow: /", ""].join("\n");
  }

  return [
    "User-agent: *",
    "Allow: /",
    // `Disallow` is checked longest-match-first by every major crawler, so these
    // win over the `Allow: /` above without needing to be ordered.
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${SITE_URL}/sitemap-index.xml`,
    "",
  ].join("\n");
}

export const GET: APIRoute = () => {
  return new Response(robotsTxt(isIndexable()), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Never cached: a change of environment must take effect immediately.
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
};
