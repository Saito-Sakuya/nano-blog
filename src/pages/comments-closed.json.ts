import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { buildClosedPostsManifest } from "../lib/comments/closed-posts.js";
import { buildNow } from "../lib/content/build-context.js";
import { isPublicAt } from "../lib/content/visibility.js";

/**
 * The list of articles that do not accept comments, as a static file.
 *
 * Generated at build time from the same frontmatter that renders the pages, so
 * the two cannot disagree: if an article's page shows no comment section, its
 * id is in this file, because both read the same field from the same entry.
 *
 * It is a page rather than something the Function computes because the Function
 * has no access to the content collection — by the time a request arrives the
 * articles are static HTML, and the frontmatter that produced them is gone.
 *
 * Served from the site root and fetched by the comment endpoint on the
 * submission that needs it, with a short cache: it changes only on deploy, and
 * the endpoint has no other way to know.
 *
 * ## Only public articles appear here
 *
 * This file is served to anyone who asks for it, so listing an unpublished
 * article would publish the existence and the exact id of work that has not
 * been announced — a draft's id is the path its page will live at. Nothing is
 * lost by filtering: an unpublished article has no page, so there is no comment
 * form anywhere for a reader to submit from, and the article's own state is
 * republished by the same build that publishes the page.
 *
 * ## The cache policy is not set here
 *
 * `output: "static"` writes the body of this response to
 * `dist/comments-closed.json` and nothing else; a `cache-control` header set
 * below would never reach the deployed file, which is why there is none. What
 * the endpoint actually receives is decided by `public/_headers`, which is the
 * only place a response header for a static asset can be declared.
 */
export const GET: APIRoute = async () => {
  const posts = await getCollection("posts");
  const now = buildNow();

  const closed = posts
    .filter((entry) => isPublicAt(entry.data, now) && !entry.data.comments)
    .map((entry) => entry.id);

  const manifest = buildClosedPostsManifest(closed);

  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
};
