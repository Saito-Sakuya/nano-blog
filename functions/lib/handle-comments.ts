import { gravatarHash } from "../../src/lib/comments/md5.js";
import {
  RATE_LIMITS,
  callerKey,
  checkRateLimit,
  secondsIntoWindow,
  windowKey,
} from "../../src/lib/comments/rate-limit.js";
import { renderCommentMarkdown } from "../../src/lib/comments/render.js";
import { validateComment } from "../../src/lib/comments/rules.js";
import type { CommentStore } from "../../src/lib/comments/store.js";

/**
 * The comment endpoint's behaviour, independent of the platform.
 *
 * Written against the `CommentStore` interface and plain values, so the Pages
 * Function in `functions/api/comments/[[postId]].ts` is a thin adapter and the
 * end-to-end stub drives this same code. The logic that decides what gets stored
 * is therefore the logic that is tested, rather than a parallel implementation
 * that only resembles it.
 *
 * The response is negotiated rather than fixed. A `fetch` from the page sends
 * `Accept: application/json` and gets JSON; a plain form submission — which is
 * what happens with JavaScript disabled, or when the script fails to load —
 * sends an HTML `Accept` and gets a minimal document back. One endpoint serves
 * both, so the no-script path is the same path, not a fallback someone has to
 * remember to maintain.
 */

/** Most comments returned for one page. */
const LIST_LIMIT = 200;

/** How long a comment body may never be, checked before anything expensive. */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * What reading a page's comments needs.
 *
 * Deliberately smaller than the submission context: the list is public, so it
 * needs no caller address and therefore no secret. Requiring them anyway — which
 * is what the first version did — meant a deployment with a missing
 * `COMMENTS_IP_SECRET` answered 500 to every reader trying to *read* comments,
 * turning a misconfiguration that should only stop writing into an outage of the
 * read path.
 */
export interface CommentListContext {
  readonly store: CommentStore;
}

export interface CommentRequestContext extends CommentListContext {
  /** Server-held secret for hashing a caller's address. */
  readonly ipSecret: string;
  /** Caller's address, from the platform's own header. */
  readonly address: string;
  readonly now: Date;
  /**
   * Whether this article accepts comments.
   *
   * Hiding the form in the markup is a courtesy to the reader; this is the
   * control. Without it `comments: false` would mean "not shown" rather than
   * "not accepted", and a comment posted straight to the endpoint would be
   * stored on an article whose author had closed it.
   *
   * The deployed route must supply it from `/comments-closed.json` — see
   * `functions/lib/closed-posts-manifest.ts` for why that wiring is shared with
   * the test harness rather than written twice. `undefined` means "the caller
   * did not ask", which is open, matching the field's own default and the
   * manifest's documented reading of a missing file.
   */
  readonly commentsEnabled?: boolean;
  /**
   * Whether the per-caller rate limits apply.
   *
   * `"unlimited"` is for the test harness only. Every browser project in a run
   * reaches the API from the same loopback address, so six projects submitting
   * comments exhaust a three-per-ten-minutes budget by the third and the
   * failures read as a broken endpoint. The limiter's own arithmetic is covered
   * by unit tests, which is where a rule about counts belongs.
   *
   * Defaults to the production rules, so a caller that forgets this gets the
   * protective behaviour rather than the permissive one.
   */
  readonly rateLimits?: "production" | "unlimited";
}

export interface CommentHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function json(
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): CommentHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

/** Escape a value for the minimal HTML confirmation page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * The document a non-JavaScript submission lands on.
 *
 * Deliberately plain and self-contained: no stylesheet, no script, no link back
 * into the site's navigation. It says what happened and offers one link, which
 * is all a confirmation needs to do. It is also the reason this endpoint works
 * with JavaScript disabled at all.
 *
 * The status code is the caller's, not always 200. This page is the whole
 * response for a submission without scripts, so a reader whose comment was
 * refused — too long, too soon, on a closed article — must be able to tell that
 * from one that was accepted, and anything machine-readable in the response
 * (a monitor, a proxy's retry policy) must see it too. The first version
 * hardcoded 200 here, which reported every rejection as a success.
 */
function html(
  status: number,
  title: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): CommentHttpResponse {
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">返回首页</a></p>
</body>
</html>
`;
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The confirmation reflects a submission, so it must not be indexed or
      // cached by anything in between.
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: document,
  };
}

/** True when the caller asked for JSON rather than a document. */
function wantsJson(accept: string | null): boolean {
  return accept !== null && accept.includes("application/json");
}

/** Read a form-encoded body into the shape the validator expects. */
function fromFormEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    out[key] = value;
  }
  return out;
}

export interface CommentSubmission {
  readonly postId: string;
  readonly body: string;
  readonly contentType: string;
  readonly accept: string | null;
}

/** GET — the approved comments for a page. */
export async function handleListComments(
  postId: string,
  context: CommentListContext,
): Promise<CommentHttpResponse> {
  const comments = await context.store.listApproved(postId, LIST_LIMIT);
  return json(
    200,
    { comments },
    {
      // A page's comments change as the author approves; a cached list would
      // show a reader their own approved comment missing.
      "cache-control": "no-store",
    },
  );
}

/** POST — accept a submission. */
export async function handleCreateComment(
  submission: CommentSubmission,
  context: CommentRequestContext,
): Promise<CommentHttpResponse> {
  const asJson = wantsJson(submission.accept);

  if (submission.body.length > MAX_REQUEST_BYTES) {
    return asJson
      ? json(413, { error: "That submission is too large." })
      : html(413, "提交过大", "提交的内容超出了大小限制。");
  }

  /*
   * A closed article is refused before the body is parsed.
   *
   * 403 rather than 404: the article exists, and saying so is more useful to a
   * client that posted to the wrong place than an unexplained "not found".
   */
  if (context.commentsEnabled === false) {
    return asJson
      ? json(403, { error: "这篇文章不接受评论。" })
      : html(403, "不接受评论", "这篇文章不接受评论。");
  }

  let fields: Record<string, unknown>;
  try {
    /*
     * A JSON body is only a submission if it parses to an object.
     *
     * `JSON.parse("null")`, `"5"` and `"[]"` all parse successfully, so catching
     * the parse error is not enough: the first version then read
     * `fields["authorName"]` off `null`, which threw out of the handler and
     * became a 500 for a request the caller could have fixed. The parsed value
     * is therefore checked before it is used, not just parsed.
     */
    const parsed: unknown = submission.contentType.includes("application/json")
      ? JSON.parse(submission.body)
      : fromFormEncoded(submission.body);

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return asJson
        ? json(400, {
            error: "The request body must be a JSON object of form fields.",
          })
        : html(400, "未能提交", "提交的内容无法读取。");
    }

    fields = parsed as Record<string, unknown>;
  } catch {
    // A body that is not the JSON it claims to be is the caller's mistake, not a
    // server error, and it must not reach the validator as a thrown exception.
    return asJson
      ? json(400, { error: "The request body could not be read." })
      : html(400, "未能提交", "提交的内容无法读取。");
  }

  const result = validateComment(
    {
      postId: submission.postId,
      authorName: fields["authorName"],
      email: fields["email"],
      bodyMarkdown: fields["bodyMarkdown"],
      trap: fields["trap"],
      // Absent when the page script did not run, which skips the timing check
      // rather than failing the submission.
      renderedAt: fields["renderedAt"],
    },
    // The server's clock decides how long the reader took.
    context.now,
  );

  if (!result.ok) {
    /*
     * A honeypot hit is answered as if it succeeded.
     *
     * Telling a bot which check caught it is free information about the filter,
     * and the response costs the operator nothing because the comment is never
     * stored. Every other failure is reported plainly, because those are for
     * people.
     */
    if (result.failure.code === "trap") {
      return asJson
        ? json(202, { status: "pending" })
        : html(202, "已提交", "评论已提交，等待审核。");
    }
    return asJson
      ? json(400, { error: result.failure.message, code: result.failure.code })
      : html(400, "未能提交", result.failure.message);
  }

  const { postId, authorName, email, bodyMarkdown } = result.value;

  // --- rate limits ---------------------------------------------------------

  /*
   * The counter is incremented first and the decision is made on the result.
   *
   * Reading a count and then recording one left a gap that concurrency walks
   * straight through: twenty submissions arriving together all read the same
   * pre-limit value and were all allowed, so "three per ten minutes" held only
   * for callers who were not trying. `consumeAction` is one atomic step, so the
   * total it returns already includes this attempt and no two requests can act
   * on the same number.
   *
   * A refused attempt therefore still counts. That is the stricter reading and
   * the right one for abuse: a caller who is over the limit should not be able
   * to keep trying for free inside the same window. The decision arithmetic
   * itself is unchanged — `checkRateLimit` is still handed the number of actions
   * *before* this one, which is what its own tests describe.
   */
  const caller = await callerKey(context.ipSecret, context.address);
  const minuteKey = windowKey("comment", context.now);
  const dayKey = windowKey("commentDaily", context.now);
  const enforcing = context.rateLimits !== "unlimited";

  const withinMinute = enforcing
    ? checkRateLimit(
        RATE_LIMITS.comment,
        (await context.store.consumeAction("comment", minuteKey, caller)) - 1,
        secondsIntoWindow("comment", minuteKey, context.now),
      )
    : { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  if (!withinMinute.allowed) {
    // The wait is worth communicating on both branches: the confirmation page is
    // the entire response for a reader without scripts, and a bare 429 with no
    // indication of when to come back is a dead end for them.
    const headers = { "retry-after": String(withinMinute.retryAfterSeconds) };
    return asJson
      ? json(429, { error: "提交过于频繁，请稍后再试。" }, headers)
      : html(429, "提交过于频繁", "提交过于频繁，请稍后再试。", headers);
  }

  const withinDay = enforcing
    ? checkRateLimit(
        RATE_LIMITS.commentDaily,
        (await context.store.consumeAction("commentDaily", dayKey, caller)) - 1,
        secondsIntoWindow("commentDaily", dayKey, context.now),
      )
    : { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  if (!withinDay.allowed) {
    const headers = { "retry-after": String(withinDay.retryAfterSeconds) };
    return asJson
      ? json(429, { error: "今天的提交次数已达上限。" }, headers)
      : html(429, "提交已达上限", "今天的提交次数已达上限。", headers);
  }

  // --- store ---------------------------------------------------------------

  const emailHash = gravatarHash(email);
  const createdAt = context.now.toISOString();

  await context.store.insert({
    // Time-ordered and random, so ids sort by arrival without being guessable
    // from one another.
    id: `${createdAt.replace(/[^0-9]/gu, "").slice(0, 14)}-${randomId()}`,
    postId,
    authorName,
    emailHash,
    bodyMarkdown,
    // Rendered and sanitised once, here, so the read path never parses
    // untrusted markdown.
    bodyHtml: renderCommentMarkdown(bodyMarkdown),
    ipHash: caller,
    createdAt,
  });

  /*
   * Prune expired counters now that a write has happened anyway.
   *
   * Best-effort by design: the table only needs pruning because it would
   * otherwise grow without bound, and a failure to prune must never fail the
   * submission that paid for it. `sweepExpired` was previously defined and
   * documented as "called after a write" while nothing called it, which is why
   * the two tables grew forever.
   */
  if (enforcing) {
    await context.store
      .sweepExpired("comment", minuteKey)
      .catch(() => undefined);
    await context.store
      .sweepExpired("commentDaily", dayKey)
      .catch(() => undefined);
  }

  /*
   * A comment is stored as `pending` and never shown until it is approved, so
   * the response must not imply it is visible. Saying "waiting for review" is
   * the difference between a commenter understanding the silence and assuming
   * the form is broken.
   */
  return asJson
    ? json(202, { status: "pending" })
    : html(202, "已提交", "评论已提交，等待审核。");
}

/** A short random suffix for a comment id. */
function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
