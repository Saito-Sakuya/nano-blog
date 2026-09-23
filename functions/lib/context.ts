import { D1CommentStore, type D1Database } from "./d1-store.js";
import type { CommentStore } from "../../src/lib/comments/store.js";

/**
 * The small amount of platform vocabulary the endpoint adapters need.
 *
 * Declared here rather than pulled from `@cloudflare/workers-types`, for the
 * same reason the D1 client is declared in `d1-store.ts`: the repository type
 * check runs on a machine that is not an edge runtime, and one dependency for
 * three property accesses would mean every `pnpm check:types` needs the Workers
 * types installed and current. The declarations are the subset actually used, so
 * a platform change that removed one of them fails this file rather than
 * silently doing nothing.
 */

/**
 * Route parameters.
 *
 * Typed as possibly absent because a param is only present when the route that
 * matched actually declared it. A catch-all segment (`[[postId]]`) arrives as a
 * single string holding the remainder of the path, which is what the comment and
 * view routes rely on — a content path contains slashes.
 */
export type RouteParams = Readonly<Record<string, string | undefined>>;

/** What a route handler receives. */
export interface PagesContext {
  readonly request: Request;
  readonly env: Record<string, unknown>;
  readonly params: RouteParams;
  /**
   * Keep a promise alive after the response is returned.
   *
   * Optional because the test harness builds a context by hand and does not need
   * one; the platform always provides it. Used for edge-cache writes, which must
   * not delay the response and would otherwise be cancelled once it is sent.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * What the middleware receives: a handler context plus the ability to call
 * through to whatever would have handled the request.
 *
 * Separate from `PagesContext` so a route handler cannot accidentally depend on
 * `next`, which only exists for middleware and would be undefined if it tried.
 */
export interface PagesMiddlewareContext extends PagesContext {
  next(): Promise<Response>;
}

/** The environment variable holding the secret used to hash caller addresses. */
export const IP_SECRET_VAR = "COMMENTS_IP_SECRET";

/** The D1 binding holding comments and view counts. */
export const DB_BINDING = "COMMENTS_DB";

/**
 * The store for this request.
 *
 * A new instance per request is fine and is what the binding gives us; D1
 * handles the connection pooling underneath.
 */
export function requireStore(context: PagesContext): CommentStore {
  const db = context.env[DB_BINDING];
  if (db === undefined || db === null) {
    throw new Error(
      `The ${DB_BINDING} binding is not configured. Comments require a D1 database; see docs/CLOUDFLARE_SETUP.md.`,
    );
  }
  return new D1CommentStore(db as D1Database);
}

/**
 * The secret used to derive a caller key.
 *
 * A missing secret is a hard failure rather than a fallback to the raw address.
 * The fallback would be the one behaviour that matters — storing addresses in
 * plaintext — and it would engage silently the first time a deployment was
 * misconfigured. An error that fails the request is the safer default.
 */
export function secret(context: PagesContext): string {
  const value = context.env[IP_SECRET_VAR];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(
      `${IP_SECRET_VAR} must be set to a long random string (at least 32 characters); see docs/CLOUDFLARE_SETUP.md.`,
    );
  }
  return value;
}

/**
 * The caller's address, as Cloudflare reports it.
 *
 * `CF-Connecting-IP` is set by the platform and cannot be forged by a client
 * through this host; `X-Forwarded-For` can, so it is only consulted when the
 * platform header is absent, and then only its first entry. The value is hashed
 * immediately by every caller and never stored or logged.
 */
export function callerAddress(request: Request): string {
  const connecting = request.headers.get("cf-connecting-ip");
  if (connecting !== null && connecting.length > 0) return connecting;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }

  return "unknown";
}
