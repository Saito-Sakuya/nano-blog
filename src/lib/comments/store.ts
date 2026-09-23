import type { CommentStatus } from "./rules.js";

/**
 * What the comment endpoints need from storage.
 *
 * An interface rather than direct SQL, for one practical reason: the end-to-end
 * tests have to exercise the comment UI against a real server, and there is no
 * D1 instance in a local test run. With the storage abstracted, the test harness
 * supplies an in-memory implementation of *this* interface and every other layer
 * — validation, rate limiting, markdown rendering, the endpoints themselves — is
 * the production code path. Only the SQL statements differ, and those are the
 * part a local test could not exercise faithfully anyway.
 *
 * `functions/` provides the D1-backed implementation; `scripts/verify/api-stub.ts`
 * provides the memory one.
 */

/** A comment as the API returns it. Never carries the email or the IP. */
export interface PublicComment {
  readonly id: string;
  readonly authorName: string;
  readonly avatarHash: string;
  readonly bodyHtml: string;
  readonly createdAt: string;
}

/** A comment as it is written, before review. */
export interface NewComment {
  readonly id: string;
  readonly postId: string;
  readonly authorName: string;
  readonly emailHash: string;
  readonly bodyMarkdown: string;
  readonly bodyHtml: string;
  readonly ipHash: string;
  readonly createdAt: string;
}

/** A comment as the moderation tool sees it. */
export interface StoredComment extends NewComment {
  readonly status: CommentStatus;
}

export interface CommentStore {
  /** Approved comments for a page, oldest first. */
  listApproved(postId: string, limit: number): Promise<PublicComment[]>;
  /** Every comment for a page, whatever its state — for the review tool. */
  listAll(
    status: CommentStatus | "any",
    limit: number,
  ): Promise<StoredComment[]>;
  insert(comment: NewComment): Promise<void>;
  setStatus(id: string, status: CommentStatus): Promise<boolean>;

  /**
   * Record a view, de-duplicated per visitor per day. True when it counted.
   *
   * `createdAt` is supplied rather than read from the clock inside the store, so
   * a test can assert what was written and an audit can explain a timestamp.
   */
  recordView(
    postId: string,
    day: string,
    visitorHash: string,
    createdAt: string,
  ): Promise<boolean>;
  /** Distinct visitors per day, summed. */
  countViews(postId: string): Promise<number>;

  /**
   * Count one action for this caller and return the window's new total.
   *
   * One operation on purpose. The endpoints used to read a count, decide, and
   * then record — three steps with no transaction around them, so twenty
   * submissions arriving together could all read the same pre-limit count and
   * all be allowed. Incrementing first and deciding on the result removes the
   * window: whatever the outcome, the caller's counter already includes this
   * attempt, which is also the stricter reading under abuse.
   */
  consumeAction(
    bucketKind: string,
    windowKey: string,
    caller: string,
  ): Promise<number>;

  /**
   * Delete counters from windows that have certainly expired.
   *
   * Best-effort and opportunistic: there is no cron in this deployment, and the
   * table's only reason to be pruned is that it would otherwise grow without
   * bound. A failure here must not fail the request that triggered it.
   */
  sweepExpired(bucketKind: string, currentWindowKey: string): Promise<void>;
}
