import type { CommentStatus } from "../../src/lib/comments/rules.js";
import type {
  CommentStore,
  NewComment,
  PublicComment,
  StoredComment,
} from "../../src/lib/comments/store.js";

/**
 * The D1-backed store.
 *
 * Thin by design: every statement is one of a handful written out in full, so
 * the SQL can be read against the schema in `migrations/` without following an
 * abstraction. Validation, hashing, rendering and the rate-limit arithmetic all
 * happen before this layer is reached.
 *
 * The types here are the subset of D1's interface this file uses, rather than
 * `@cloudflare/workers-types`. That avoids a dependency for four methods, and it
 * means the file compiles in a Node type-check without the Workers types being
 * installed — which matters because `pnpm check:types` runs over the whole
 * repository on a machine that is not an edge runtime.
 */

/** The slice of a D1 prepared statement this file calls. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}

/** What one statement in a batch answers with. */
export interface D1Result<T = unknown> {
  readonly results?: T[];
  readonly success?: boolean;
  readonly meta?: { readonly changes?: number };
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /**
   * Run statements as one transaction. D1 documents a batch as atomic, which is
   * what makes "increment, then read the new total" a single decision rather
   * than the read-then-write the rate limiter used to depend on.
   */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface CommentRow {
  id: string;
  post_id: string;
  author_name: string;
  email_hash: string;
  body_markdown: string;
  body_html: string;
  ip_hash: string;
  status: string;
  created_at: string;
}

function toStored(row: CommentRow): StoredComment {
  return {
    id: row.id,
    postId: row.post_id,
    authorName: row.author_name,
    emailHash: row.email_hash,
    bodyMarkdown: row.body_markdown,
    bodyHtml: row.body_html,
    ipHash: row.ip_hash,
    status: row.status as CommentStatus,
    createdAt: row.created_at,
  };
}

/** Rows older than this are deleted when the sweep runs. */
const SWEEP_AFTER_WINDOWS = 2;

export class D1CommentStore implements CommentStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async listApproved(postId: string, limit: number): Promise<PublicComment[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, author_name, email_hash, body_html, created_at
           FROM comments
          WHERE post_id = ? AND status = 'approved'
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(postId, limit)
      .all<{
        id: string;
        author_name: string;
        email_hash: string;
        body_html: string;
        created_at: string;
      }>();

    return (results ?? []).map((row) => ({
      id: row.id,
      authorName: row.author_name,
      avatarHash: row.email_hash,
      bodyHtml: row.body_html,
      createdAt: row.created_at,
    }));
  }

  async listAll(
    status: CommentStatus | "any",
    limit: number,
  ): Promise<StoredComment[]> {
    const statement =
      status === "any"
        ? this.#db
            .prepare(`SELECT * FROM comments ORDER BY created_at DESC LIMIT ?`)
            .bind(limit)
        : this.#db
            .prepare(
              `SELECT * FROM comments WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .bind(status, limit);

    const { results } = await statement.all<CommentRow>();
    return (results ?? []).map(toStored);
  }

  async insert(comment: NewComment): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO comments
           (id, post_id, author_name, email_hash, body_markdown, body_html,
            ip_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        comment.id,
        comment.postId,
        comment.authorName,
        comment.emailHash,
        comment.bodyMarkdown,
        comment.bodyHtml,
        comment.ipHash,
        comment.createdAt,
      )
      .run();
  }

  async setStatus(id: string, status: CommentStatus): Promise<boolean> {
    const result = await this.#db
      .prepare(`UPDATE comments SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async recordView(
    postId: string,
    day: string,
    visitorHash: string,
    createdAt: string,
  ): Promise<boolean> {
    /*
     * `INSERT OR IGNORE` against the primary key is the whole de-duplication:
     * a repeat visit within the day conflicts and changes nothing. Checking
     * `changes` rather than reading first avoids a race between two requests
     * from the same reader arriving together, which a read-then-write would
     * lose and would count twice.
     */
    const result = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO views (post_id, day, visitor_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(postId, day, visitorHash, createdAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async countViews(postId: string): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT COUNT(*) AS total FROM views WHERE post_id = ?`)
      .bind(postId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  /**
   * Increment this caller's counter and read the new total, as one transaction.
   *
   * The two statements are batched, so the total that comes back already
   * includes this action and no second request can read a stale count in
   * between. That is what makes the limiter hold under concurrency; the previous
   * read-then-decide-then-record sequence could not, because twenty submissions
   * arriving together all read the same pre-limit value and were all allowed.
   */
  async consumeAction(
    bucketKind: string,
    windowKey: string,
    caller: string,
  ): Promise<number> {
    const [, counted] = await this.#db.batch<{ count: number }>([
      this.#db
        .prepare(
          `INSERT INTO rate_limits (bucket_kind, window_key, caller, count, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (bucket_kind, window_key, caller)
           DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
        )
        .bind(bucketKind, windowKey, caller, new Date().toISOString()),
      this.#db
        .prepare(
          `SELECT count FROM rate_limits
            WHERE bucket_kind = ? AND window_key = ? AND caller = ?`,
        )
        .bind(bucketKind, windowKey, caller),
    ]);

    /*
     * A missing row means the batch did not do what it says, and returning 1
     * would silently let the caller through as if this were their first action
     * of the window. Counting it as the limit is the fail-closed reading: an
     * unreadable counter must not become an unlimited one.
     */
    const total = counted?.results?.[0]?.count;
    return typeof total === "number" && Number.isFinite(total)
      ? total
      : Infinity;
  }

  /**
   * Delete counters from windows that have certainly expired.
   *
   * Called opportunistically after a write rather than on a schedule: there is
   * no cron in this deployment, and a table of counters is worth pruning only
   * because it would otherwise grow without bound. Best-effort — a failure here
   * must not fail the request that triggered it.
   */
  async sweepExpired(
    bucketKind: string,
    currentWindowKey: string,
  ): Promise<void> {
    const current = Number(currentWindowKey);
    if (!Number.isFinite(current)) return;
    const cutoff = String(current - SWEEP_AFTER_WINDOWS);
    await this.#db
      .prepare(
        `DELETE FROM rate_limits
          WHERE bucket_kind = ? AND window_key < ?`,
      )
      .bind(bucketKind, cutoff)
      .run();
  }
}
