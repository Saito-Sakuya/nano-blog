import { describe, expect, it } from "vitest";

import {
  handleCreateComment,
  handleListComments,
  type CommentRequestContext,
  type CommentSubmission,
} from "../../functions/lib/handle-comments.js";
import { MemoryCommentStore } from "../../src/lib/comments/memory-store.js";

/**
 * The comment endpoint, driven through its own entry point.
 *
 * These are the behaviours that were wrong or unreachable and are now covered
 * where they belong — at the handler, not only through a browser:
 *
 *   - a JSON body of `null` used to throw out of the handler and become a 500;
 *   - the closed-article check existed but was never reached in production;
 *   - the rate limit read a count and wrote one later, so concurrent
 *     submissions all passed.
 *
 * The deployed route is a thin adapter over this function, so a case here is a
 * case in production as long as the adapter passes what this file passes.
 */

const NOW = new Date("2026-09-15T09:00:00+08:00");

function submission(
  overrides: Partial<CommentSubmission> = {},
): CommentSubmission {
  return {
    postId: "notes/first-note",
    body: JSON.stringify({
      authorName: "读者",
      email: "reader@example.invalid",
      bodyMarkdown: "这是一条足够长的测试评论。",
    }),
    contentType: "application/json",
    accept: "application/json",
    ...overrides,
  };
}

function context(
  overrides: Partial<CommentRequestContext> = {},
): CommentRequestContext {
  return {
    store: new MemoryCommentStore(),
    ipSecret: "a-long-enough-test-secret-for-hashing-callers",
    address: "203.0.113.7",
    now: NOW,
    ...overrides,
  };
}

describe("handleCreateComment — bodies", () => {
  it("accepts an ordinary submission and stores it as pending", async () => {
    const store = new MemoryCommentStore();
    const result = await handleCreateComment(submission(), context({ store }));

    expect(result.status).toBe(202);
    expect(JSON.parse(result.body)).toEqual({ status: "pending" });

    const stored = await store.listAll("pending", 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.authorName).toBe("读者");
  });

  it("answers 400 rather than 500 when a JSON body is the literal null", async () => {
    /*
     * `JSON.parse("null")` succeeds, so catching the parse error was not enough:
     * the handler then read `fields["authorName"]` off `null`, which threw and
     * became a platform 500 for a request the caller could have fixed.
     */
    const store = new MemoryCommentStore();
    const result = await handleCreateComment(
      submission({ body: "null" }),
      context({ store }),
    );

    expect(result.status).toBe(400);
    expect(await store.listAll("any", 10)).toHaveLength(0);
  });

  it("answers 400 for a JSON body that is not an object", async () => {
    const store = new MemoryCommentStore();
    for (const body of ["5", '"text"', "[]"]) {
      const result = await handleCreateComment(
        submission({ body }),
        context({ store }),
      );
      expect(result.status, `body ${body}`).toBe(400);
    }
    expect(await store.listAll("any", 10)).toHaveLength(0);
  });

  it("answers 400 for a body that is not the JSON it claims to be", async () => {
    const result = await handleCreateComment(
      submission({ body: "{not json" }),
      context(),
    );
    expect(result.status).toBe(400);
  });
});

describe("handleCreateComment — a closed article", () => {
  it("refuses with 403 and stores nothing", async () => {
    const store = new MemoryCommentStore();
    const result = await handleCreateComment(
      submission(),
      context({ store, commentsEnabled: false }),
    );

    expect(result.status).toBe(403);
    expect(await store.listAll("any", 10)).toHaveLength(0);
  });

  it("is open when the flag is absent, matching the field's own default", async () => {
    const result = await handleCreateComment(submission(), context());
    expect(result.status).toBe(202);
  });
});

describe("handleCreateComment — rate limits", () => {
  it("allows the third submission in a window and refuses the fourth", async () => {
    /*
     * The boundary the rule describes, asserted end to end rather than on the
     * arithmetic alone — this is the case a check-then-act limiter got wrong,
     * because four requests arriving together all read a count of zero.
     */
    const store = new MemoryCommentStore();
    const shared = context({ store });

    for (const attempt of [1, 2, 3]) {
      const result = await handleCreateComment(submission(), shared);
      expect(result.status, `attempt ${String(attempt)}`).toBe(202);
    }

    const refused = await handleCreateComment(submission(), shared);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts concurrent submissions against one limit", async () => {
    // Six submissions at once: three may be stored, and the limiter is the only
    // thing that decides which. A read-then-write limiter stored all six.
    const store = new MemoryCommentStore();
    const shared = context({ store });

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => handleCreateComment(submission(), shared)),
    );
    const accepted = results.filter((result) => result.status === 202);
    const refused = results.filter((result) => result.status === 429);

    expect(accepted).toHaveLength(3);
    expect(refused).toHaveLength(3);
    expect(await store.listAll("pending", 10)).toHaveLength(3);
  });

  it("does not consume a slot for a submission the honeypot caught", async () => {
    // The trap is answered before the limiter, so a bot cannot exhaust an
    // honest reader's budget by posting to the same article.
    const store = new MemoryCommentStore();
    const shared = context({ store });
    const trapped = submission({
      body: JSON.stringify({
        authorName: "机器人",
        email: "bot@example.invalid",
        bodyMarkdown: "买点东西吧。",
        trap: "filled",
      }),
    });

    for (const _ of [1, 2, 3, 4, 5]) {
      const result = await handleCreateComment(trapped, shared);
      expect(result.status).toBe(202);
    }

    const honest = await handleCreateComment(submission(), shared);
    expect(honest.status).toBe(202);
  });
});

describe("handleCreateComment — the no-script branch", () => {
  it("reports a refusal with a real status code, not 200", async () => {
    const result = await handleCreateComment(
      submission({
        body: new URLSearchParams({
          authorName: "读者",
          email: "reader@example.invalid",
          bodyMarkdown: "x",
        }).toString(),
        contentType: "application/x-www-form-urlencoded",
        accept: "text/html",
      }),
      context(),
    );

    // Too short to be a comment: the confirmation page must not claim success.
    expect(result.status).toBe(400);
    expect(result.headers["content-type"]).toContain("text/html");
  });

  it("answers 202 for an accepted submission", async () => {
    const result = await handleCreateComment(
      submission({
        body: new URLSearchParams({
          authorName: "读者",
          email: "reader@example.invalid",
          bodyMarkdown: "这是一条足够长的测试评论。",
        }).toString(),
        contentType: "application/x-www-form-urlencoded",
        accept: "text/html",
      }),
      context(),
    );

    expect(result.status).toBe(202);
    expect(result.body).toContain("等待审核");
  });

  it("carries Retry-After on a refusal the reader can act on", async () => {
    const store = new MemoryCommentStore();
    const shared = context({ store });
    for (const _ of [1, 2, 3]) {
      await handleCreateComment(submission(), shared);
    }

    const refused = await handleCreateComment(
      submission({ accept: "text/html" }),
      shared,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
  });

  it("does not put a javascript: URL in its own confirmation page", async () => {
    // The page used to offer `javascript:history.back()`, which the site's own
    // CSP forbids — the link was inert on the deployment and a bad example
    // anywhere else.
    const result = await handleCreateComment(
      submission({
        body: new URLSearchParams({
          authorName: "读者",
          email: "reader@example.invalid",
          bodyMarkdown: "这是一条足够长的测试评论。",
        }).toString(),
        contentType: "application/x-www-form-urlencoded",
        accept: "text/html",
      }),
      context(),
    );

    expect(result.body).not.toContain("javascript:");
  });
});

describe("handleListComments", () => {
  it("needs no secret, because reading is public", async () => {
    /*
     * The route used to call the address-hashing secret for this, so a
     * deployment missing `COMMENTS_IP_SECRET` answered 500 to every reader
     * looking at comments it could have shown. The narrowed context type is the
     * fix; this asserts the shape it enables.
     */
    const store = new MemoryCommentStore();
    const result = await handleListComments("notes/first-note", { store });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ comments: [] });
  });
});
