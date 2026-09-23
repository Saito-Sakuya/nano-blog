import {
  handleCreateComment,
  handleListComments,
} from "../../lib/handle-comments.js";
import {
  callerAddress,
  requireStore,
  secret,
  type PagesContext,
} from "../../lib/context.js";
import { createOriginClosedPostsLoader } from "../../lib/closed-posts-manifest.js";

/**
 * `/api/comments/<postId>`
 *
 * A Pages Function, so this file runs on Cloudflare's edge rather than at build
 * time. It is a thin adapter and should stay one: everything it delegates to is
 * in `functions/lib/` against a storage interface, which is what lets the
 * end-to-end tests exercise the same code without a database.
 *
 * A catch-all segment (`[[postId]]`) because a page identifier is a content
 * path and may contain slashes — `dev/web/deep/nested` is a valid article. The
 * value is validated as a path before it reaches storage.
 *
 * ## The closed-articles control
 *
 * `comments: false` is enforced here or nowhere. The markup hides the form for
 * the reader and `handleCreateComment` refuses the submission, but the two only
 * meet because this file tells the handler which articles are closed. The
 * manifest is read through `functions/lib/closed-posts-manifest.ts`, the same
 * loader the end-to-end harness builds from — so the flag cannot be supplied by
 * one and forgotten by the other. Forgetting it is not hypothetical: this route
 * previously omitted the field entirely, which made the 403 branch unreachable
 * in production while the browser test passed against a harness that injected
 * it.
 */

/*
 * Built once per isolate. The loader caches the manifest after a successful
 * read, so the common path costs one fetch per isolate rather than one per
 * submission; a failed read is retried on the next request rather than
 * remembered.
 */
const loadClosedPosts = createOriginClosedPostsLoader();

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const postId = context.params["postId"] ?? "";
  /*
   * Only the store. Reading approved comments is public, so it must not depend
   * on the secret used to hash caller addresses — requiring it turned a missing
   * `COMMENTS_IP_SECRET`, which should only stop writing, into a 500 on every
   * page that shows comments.
   */
  const result = await handleListComments(postId, {
    store: requireStore(context),
  });
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const postId = context.params["postId"] ?? "";
  const body = await context.request.text();
  const closed = await loadClosedPosts(context.request);

  const result = await handleCreateComment(
    {
      postId,
      body,
      contentType: context.request.headers.get("content-type") ?? "",
      accept: context.request.headers.get("accept"),
    },
    {
      store: requireStore(context),
      ipSecret: secret(context),
      address: callerAddress(context.request),
      now: new Date(),
      commentsEnabled: !closed.has(postId),
    },
  );

  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
