import {
  RATE_LIMITS,
  callerKey,
  checkRateLimit,
  secondsIntoWindow,
  windowKey,
} from "../../src/lib/comments/rate-limit.js";
import type { CommentStore } from "../../src/lib/comments/store.js";

/**
 * View counts.
 *
 * ## What the number means
 *
 * It counts **distinct visitors per day, summed over days**. Not page views: a
 * reader who opens an article four times in an afternoon contributes one, and
 * the same reader returning tomorrow contributes another. That is a deliberate
 * choice about honesty rather than about storage.
 *
 * A raw request counter would be trivial to implement and would report a number
 * that is mostly the author's own refresh key. A number that goes up when nobody
 * new reads anything is not a measurement, and publishing it would be worse than
 * publishing nothing. De-duplication via the primary key gives a figure that can
 * be described in one sentence, and the sentence is true.
 *
 * Two consequences are stated in the documentation rather than hidden:
 *
 * - it over-counts nobody and **under-counts** readers who never run scripts, so
 *   it is a floor rather than a total;
 * - it is de-duplicated by hashed address, so a reader using two networks counts
 *   twice, and a household behind one address counts once.
 *
 * ## Why the increment is a POST and the read is a GET
 *
 * The count is read on page render and the increment is a separate request. The
 * increment is allowed to fail silently: a reader who cannot reach it loses
 * nothing, and the alternative — blocking the article on a write — would let a
 * failure in a statistics feature break reading, which is the wrong trade for
 * the least important feature on the site.
 */

export interface ViewsListContext {
  readonly store: CommentStore;
}

export interface ViewsRequestContext extends ViewsListContext {
  readonly ipSecret: string;
  readonly address: string;
  readonly now: Date;
  /**
   * Whether the per-caller rate limit applies.
   *
   * `"unlimited"` is for the test harness only, and it is needed here as much as
   * for comments: the console-noise test walks thirteen pages per browser
   * project, each of which records a view, and five projects from one loopback
   * address exhaust a sixty-per-ten-minutes budget. The limit's own arithmetic
   * is covered by unit tests.
   *
   * Defaults to the production rules, so a caller that forgets this gets the
   * protective behaviour rather than the permissive one.
   */
  readonly rateLimits?: "production" | "unlimited";
}

export interface ViewsHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function json(
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): ViewsHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

/** The UTC date a visit belongs to. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Is this a content path the site could actually have? */
export function isPostId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//")
  );
}

/** GET — the current count for a page. */
export async function handleGetViews(
  postId: string,
  context: ViewsListContext,
): Promise<ViewsHttpResponse> {
  const total = await context.store.countViews(postId);
  return json(
    200,
    { postId, views: total },
    {
      // Counts move slowly and stale-by-seconds is invisible; caching for a
      // minute keeps a popular page from querying on every read.
      "cache-control": "public, max-age=60",
    },
  );
}

/**
 * POST — record a visit.
 *
 * Answers 202 whether or not the visit was new, so the response cannot be used
 * to probe whether a given visitor has been counted before.
 */
export async function handleRecordView(
  postId: string,
  context: ViewsRequestContext,
): Promise<ViewsHttpResponse> {
  const caller = await callerKey(context.ipSecret, context.address);
  const key = windowKey("view", context.now);
  const enforcing = context.rateLimits !== "unlimited";

  /*
   * Increment first, decide on the result — the same shape as the comment
   * endpoint, and for the same reason: a read followed by a write lets
   * concurrent requests share one stale count. `checkRateLimit` still receives
   * the number of actions before this one.
   */
  const decision = enforcing
    ? checkRateLimit(
        RATE_LIMITS.view,
        (await context.store.consumeAction("view", key, caller)) - 1,
        secondsIntoWindow("view", key, context.now),
      )
    : { allowed: true, remaining: 0, retryAfterSeconds: 0 };

  if (!decision.allowed) {
    return json(
      429,
      { error: "Too many requests." },
      { "retry-after": String(decision.retryAfterSeconds) },
    );
  }

  await context.store.recordView(
    postId,
    utcDay(context.now),
    caller,
    context.now.toISOString(),
  );

  if (enforcing) {
    // Opportunistic pruning, as documented on the store method; a failure to
    // prune is not a failure to count.
    await context.store.sweepExpired("view", key).catch(() => undefined);
  }

  // The count is not returned. A reader does not need it, and returning it
  // would make every view a read of the whole table.
  return json(202, { status: "recorded" });
}
