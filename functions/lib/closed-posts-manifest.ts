import {
  CLOSED_POSTS_PATH,
  parseClosedPosts,
} from "../../src/lib/comments/closed-posts.js";
import { assertFetchableOrigin } from "./outbound-url.js";

/**
 * The reader for the closed-articles manifest, shared by everything that needs
 * to know whether an article accepts comments.
 *
 * ## Why this file exists
 *
 * The build writes `/comments-closed.json`, and the comment endpoint has to read
 * it to make `comments: false` mean "not accepted" rather than only "not shown".
 * The deployed Function and the end-to-end harness reach that file by different
 * means — one over HTTP from its own origin, one from the build directory — and
 * the first version of this code let them drift: the harness supplied the flag
 * itself, so the test asserting a closed article returns 403 passed against the
 * harness while the deployed route never passed the flag at all and the check
 * was unreachable in production.
 *
 * The fix is structural rather than a corrected line: both callers now build
 * their loader from *this* factory, so the parsing, the caching and the failure
 * behaviour cannot differ. Only the "how do I get the bytes" function differs,
 * and that is exactly the part a local test cannot exercise faithfully.
 *
 * ## Failure behaviour
 *
 * A manifest that cannot be read yields "nothing is closed", which is the
 * reading `parseClosedPosts` documents and the same one the markup assumes: a
 * deployment that lost the file accepts comments rather than silently rejecting
 * every one. A failure is deliberately *not* cached — a transient network error
 * must not close the manifest for the life of the isolate — while a successful
 * read is, so the common path costs one fetch per isolate rather than one per
 * submission.
 */

/** Where the manifest is served from, re-exported so callers need one import. */
export { CLOSED_POSTS_PATH };

/**
 * Build a loader over some way of obtaining the manifest.
 *
 * `read` is called at most once per successful result. It may throw; a throw is
 * treated as "no articles are closed" and is retried on the next call.
 */
export function createClosedPostsLoader(
  read: () => Promise<unknown>,
): () => Promise<ReadonlySet<string>> {
  let cached: ReadonlySet<string> | undefined;
  let inFlight: Promise<ReadonlySet<string>> | undefined;

  return async (): Promise<ReadonlySet<string>> => {
    if (cached !== undefined) return cached;
    // One fetch per isolate, not one per concurrent request: two submissions
    // arriving together must not both pay for the manifest.
    if (inFlight !== undefined) return inFlight;

    inFlight = (async (): Promise<ReadonlySet<string>> => {
      try {
        const value = await read();
        cached = parseClosedPosts(value);
        return cached;
      } catch {
        return new Set<string>();
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  };
}

/**
 * The loader a deployed Function uses: fetch the manifest from this deployment.
 *
 * The origin is remembered from the first request that needed it, because a
 * Pages project serves one origin and re-deriving it per request would be work
 * for nothing. It is set on the first call rather than at module load because a
 * module-level `fetch` cannot know its own hostname.
 *
 * It is also the one destination in this layer that comes from the request
 * rather than from a constant, so it goes through `assertFetchableOrigin` before
 * it is fetched — see that module for what the check rules out. A rejected
 * origin throws, which the loader above turns into "nothing is closed": the
 * manifest cannot be read, so the deployment behaves as if no article had
 * comments switched off.
 */
export function createOriginClosedPostsLoader(): (
  request: Request,
) => Promise<ReadonlySet<string>> {
  let origin: string | undefined;

  const load = createClosedPostsLoader(async (): Promise<unknown> => {
    if (origin === undefined) {
      throw new Error("the manifest origin is not known yet");
    }
    const response = await fetch(new URL(CLOSED_POSTS_PATH, origin), {
      headers: { accept: "application/json" },
      // The manifest is a build artifact on the same origin; sending the
      // reader's request headers along would be a needless leak of their
      // address into a subrequest's logs.
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(
        `the closed-posts manifest answered ${String(response.status)}`,
      );
    }
    return (await response.json()) as unknown;
  });

  return async (request: Request): Promise<ReadonlySet<string>> => {
    origin ??= assertFetchableOrigin(new URL(request.url).origin).origin;
    return load();
  };
}
