import { readFileSync } from "node:fs";
import path from "node:path";

import {
  handleCreateComment,
  handleListComments,
} from "../../functions/lib/handle-comments.js";
import { createClosedPostsLoader } from "../../functions/lib/closed-posts-manifest.js";
import { CLOSED_POSTS_PATH } from "../../src/lib/comments/closed-posts.js";
import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import {
  handleGetViews,
  handleRecordView,
} from "../../functions/lib/handle-views.js";
import { MemoryCommentStore } from "../../src/lib/comments/memory-store.js";
import { identiconSvg } from "../../src/lib/comments/identicon.js";
import type { CommentStore } from "../../src/lib/comments/store.js";

/**
 * The comment and view API, in process, for the test runs and local development.
 *
 * The handlers this serves are the ones that ship: `handleListComments`,
 * `handleCreateComment`, `handleGetViews` and `handleRecordView` are imported
 * from `functions/lib/` rather than reimplemented, and the closed-articles
 * manifest is read through the loader factory the deployed route also builds
 * from. Only the parts a local test could not exercise faithfully differ:
 *
 *   - storage is `MemoryCommentStore` instead of D1;
 *   - the caller's address comes from the socket rather than from
 *     `CF-Connecting-IP`, because there is no Cloudflare in front of a test;
 *   - the manifest is read from the build directory rather than fetched from
 *     the deployment's own origin.
 *
 * Everything between those two — URL routing, request parsing, validation,
 * hashing, rate limiting, markdown rendering, sanitising, status codes and
 * response headers — is the production path. That is the whole point: a stub
 * that reimplemented the endpoint would test the stub.
 *
 * Hashing still happens, including for the caller address, so the code paths
 * that derive keys are covered rather than skipped.
 */

/** Any string works locally; production requires a real secret, and says so. */
const LOCAL_SECRET = "local-development-secret-not-used-in-production-0000";

export interface ApiStub {
  readonly store: CommentStore;
  /** Handle a request, or return `null` when the path is not the API's. */
  handle(request: Request, address: string): Promise<Response | null>;
}

/** Read a JSON or form-encoded body into the shape the handlers expect. */
async function readBody(
  request: Request,
): Promise<{ body: string; contentType: string }> {
  return {
    body: await request.text(),
    contentType: request.headers.get("content-type") ?? "",
  };
}

/**
 * The set of articles that do not accept comments.
 *
 * Built from the *same loader factory the deployed Function uses*
 * (`functions/lib/closed-posts-manifest.ts`), differing only in how the bytes
 * are obtained: this one reads the built file from disk, the deployed one
 * fetches it from its own origin. That sharing is the point. An earlier version
 * of this file read the manifest itself and then decided the flag on its own,
 * which is how the browser test for "a closed article refuses comments" came to
 * pass here while the deployed route never passed the flag at all — the test was
 * exercising the harness, not the product.
 *
 * A missing manifest means everything is open, matching the deployed reading.
 */
function createDiskClosedPostsLoader(
  root: string,
): () => Promise<ReadonlySet<string>> {
  return createClosedPostsLoader(async (): Promise<unknown> => {
    const raw = readFileSync(
      path.join(root, CLOSED_POSTS_PATH.replace(/^\//u, "")),
      "utf8",
    );
    return JSON.parse(raw) as unknown;
  });
}

/**
 * Turn the rate limiter off for a run.
 *
 * The limits are per caller, and every browser project in a test run reaches the
 * API from the same loopback address. Six projects each submitting a comment
 * therefore exhaust a three-per-ten-minutes budget by the third one, and the
 * failures look like a broken endpoint rather than an exhausted budget.
 *
 * Passing `null` disables the limit for the harness only. The limiter itself is
 * covered directly by unit tests, which is where a rule about counts belongs —
 * exercising it through six parallel browser projects measures the harness, not
 * the rule.
 */
export interface ApiStubOptions {
  readonly store?: CommentStore;
  readonly buildRoot?: string;
  /** `null` disables rate limiting; omit to apply the production rules. */
  readonly rateLimits?: "production" | null;
}

export function createApiStub(options: ApiStubOptions = {}): ApiStub {
  const store = options.store ?? new MemoryCommentStore();
  const closed = createDiskClosedPostsLoader(
    options.buildRoot ?? path.join(PROJECT_ROOT, "dist-fixtures"),
  );
  /*
   * One translation, so both endpoints read the same value. The option is
   * `null` to disable because that reads better at the call site; the handlers
   * take `"unlimited"` because their type is shared with production code that
   * has no business knowing about a test harness.
   */
  const rateLimits =
    options.rateLimits === null
      ? ("unlimited" as const)
      : ("production" as const);

  return {
    store,
    async handle(request, address): Promise<Response | null> {
      const url = new URL(request.url);
      const path = url.pathname;
      const now = new Date();

      const context = {
        store,
        ipSecret: LOCAL_SECRET,
        address,
        now,
        // The same switch reaches both endpoints; see the note on ApiStubOptions.
        rateLimits,
      };

      // --- views -----------------------------------------------------------

      const viewMatch = /^\/api\/views\/(.+)$/u.exec(path);
      if (viewMatch !== null) {
        const postId = decodeURIComponent(viewMatch[1] ?? "");
        const result =
          request.method === "POST"
            ? await handleRecordView(postId, context)
            : await handleGetViews(postId, context);
        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      }

      // --- comments --------------------------------------------------------

      const commentMatch = /^\/api\/comments\/(.+)$/u.exec(path);
      if (commentMatch !== null) {
        const postId = decodeURIComponent(commentMatch[1] ?? "");

        if (request.method === "POST") {
          const { body, contentType } = await readBody(request);
          const result = await handleCreateComment(
            {
              postId,
              body,
              contentType,
              accept: request.headers.get("accept"),
            },
            { ...context, commentsEnabled: !(await closed()).has(postId) },
          );
          return new Response(result.body, {
            status: result.status,
            headers: result.headers,
          });
        }

        const result = await handleListComments(postId, context);
        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      }

      // --- avatars ---------------------------------------------------------

      const avatarMatch = /^\/avatar\/([^/]+)$/u.exec(path);
      if (avatarMatch !== null) {
        const hash = (avatarMatch[1] ?? "").toLowerCase();
        if (!/^[0-9a-f]{32}$/u.test(hash)) {
          return new Response("Not found", { status: 404 });
        }
        /*
         * No upstream request. The deployed proxy asks Gravatar and falls back
         * to a generated mark; a test run has no business calling a third party,
         * and the fallback is the branch worth exercising anyway since it is the
         * one that must never fail.
         */
        return new Response(identiconSvg({ hash, size: 160 }), {
          status: 200,
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      }

      return null;
    },
  };
}

export { LOCAL_SECRET };
