import type {
  CommentStore,
  NewComment,
  PublicComment,
  StoredComment,
} from "./store.js";
import type { CommentStatus } from "./rules.js";

/**
 * An in-memory implementation of the comment store.
 *
 * Two callers need it and both are outside production: the end-to-end harness,
 * which has to exercise the comment form against a running server without a D1
 * instance, and `pnpm dev:api`, which lets the comment UI be developed locally.
 * In both cases everything above this file is the production code path — the
 * validation, the hashing, the markdown rendering, the endpoints and the
 * responses — so what the tests exercise is what ships, minus the SQL.
 *
 * Not imported by any page or component, so it is never part of a bundle.
 *
 * The behaviour deliberately mirrors `functions/lib/d1-store.ts` rather than
 * being convenient: `recordView` de-duplicates on the same key the table's
 * primary key uses, and `insert` starts a comment in `pending`. A double that
 * were permissive here would let a test pass on behaviour production does not
 * have.
 */

/**
 * Windows to keep behind the current one before a counter is swept.
 *
 * The same value the D1 implementation uses, deliberately: if the two disagreed,
 * a test could watch a counter survive here and disappear there, or the reverse,
 * and neither behaviour would be the one production has.
 */
const SWEEP_AFTER_WINDOWS = 2;

export class MemoryCommentStore implements CommentStore {
  readonly #comments: StoredComment[] = [];
  readonly #views = new Set<string>();
  readonly #actions = new Map<string, number>();

  async listApproved(postId: string, limit: number): Promise<PublicComment[]> {
    return this.#comments
      .filter(
        (comment) => comment.postId === postId && comment.status === "approved",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map((comment) => ({
        id: comment.id,
        authorName: comment.authorName,
        avatarHash: comment.emailHash,
        bodyHtml: comment.bodyHtml,
        createdAt: comment.createdAt,
      }));
  }

  async listAll(
    status: CommentStatus | "any",
    limit: number,
  ): Promise<StoredComment[]> {
    return this.#comments
      .filter((comment) => status === "any" || comment.status === status)
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map((comment) => ({ ...comment }));
  }

  async insert(comment: NewComment): Promise<void> {
    this.#comments.push({ ...comment, status: "pending" });
  }

  async setStatus(id: string, status: CommentStatus): Promise<boolean> {
    const comment = this.#comments.find((entry) => entry.id === id);
    if (comment === undefined) return false;
    Object.assign(comment, { status });
    return true;
  }

  async recordView(
    postId: string,
    day: string,
    visitorHash: string,
    _createdAt: string,
  ): Promise<boolean> {
    const key = `${postId}\u0000${day}\u0000${visitorHash}`;
    if (this.#views.has(key)) return false;
    this.#views.add(key);
    return true;
  }

  async countViews(postId: string): Promise<number> {
    let total = 0;
    for (const key of this.#views) {
      if (key.startsWith(`${postId}\u0000`)) total += 1;
    }
    return total;
  }

  async consumeAction(
    bucketKind: string,
    windowKey: string,
    caller: string,
  ): Promise<number> {
    const key = this.#keyFor(bucketKind, windowKey, caller);
    const next = (this.#actions.get(key) ?? 0) + 1;
    this.#actions.set(key, next);
    return next;
  }

  async sweepExpired(
    bucketKind: string,
    currentWindowKey: string,
  ): Promise<void> {
    const current = Number(currentWindowKey);
    if (!Number.isFinite(current)) return;
    const cutoff = current - SWEEP_AFTER_WINDOWS;
    for (const key of [...this.#actions.keys()]) {
      const [kind = "", window = ""] = key.split("\u0000");
      if (kind !== bucketKind) continue;
      if (Number(window) < cutoff) this.#actions.delete(key);
    }
  }

  #keyFor(bucketKind: string, windowKey: string, caller: string): string {
    return `${bucketKind}\u0000${windowKey}\u0000${caller}`;
  }
}
