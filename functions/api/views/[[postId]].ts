import {
  handleGetViews,
  handleRecordView,
  isPostId,
} from "../../lib/handle-views.js";
import {
  callerAddress,
  requireStore,
  secret,
  type PagesContext,
} from "../../lib/context.js";

/**
 * `/api/views/<postId>`
 *
 * GET reads the count, POST records a visit. Catch-all segment for the same
 * reason as the comment endpoint: a page identifier is a content path and may
 * contain slashes.
 *
 * The GET is cached at the edge. `handleGetViews` advertises a sixty-second
 * lifetime, but a Function's response is not automatically cached by Cloudflare
 * — without an explicit `caches.default` entry the header was only a promise to
 * intermediaries, and every reader of a popular article cost a `COUNT(*)` over
 * that article's visitor rows. The count moves slowly enough that a minute of
 * staleness is invisible, and this is the one endpoint where the read is far
 * more frequent than the write.
 */

/** The edge cache, when there is one. Declared structurally to avoid a DOM lib. */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | undefined {
  const holder = globalThis as { caches?: { default?: EdgeCache } };
  return holder.caches?.default;
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Unknown page." }), {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const postId = context.params["postId"] ?? "";
  if (!isPostId(postId)) return notFound();

  /*
   * The cache key is built from the request's own origin so a preview
   * deployment cannot read a production cache entry, and it deliberately drops
   * the caller's headers: a cached count must not vary by reader.
   */
  const cache = edgeCache();
  const key = new Request(
    new URL(
      `/api/views/${encodeURIComponent(postId)}`,
      context.request.url,
    ).toString(),
    { method: "GET" },
  );

  const hit = await cache?.match(key);
  if (hit !== undefined) return hit;

  // The read path needs no caller address, so it needs no secret; asking for
  // one made a missing secret break reading as well as writing.
  const result = await handleGetViews(postId, {
    store: requireStore(context),
  });
  const response = new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });

  if (cache !== undefined && result.status === 200) {
    const store = cache.put(key, response.clone());
    if (context.waitUntil !== undefined) context.waitUntil(store);
    else await store;
  }

  return response;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const postId = context.params["postId"] ?? "";
  if (!isPostId(postId)) return notFound();

  const result = await handleRecordView(postId, {
    store: requireStore(context),
    ipSecret: secret(context),
    address: callerAddress(context.request),
    now: new Date(),
  });
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
