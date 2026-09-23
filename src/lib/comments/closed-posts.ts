/**
 * The list of articles that do not accept comments.
 *
 * ## Why a manifest rather than a query
 *
 * The comment endpoint runs at the edge and has no access to the content
 * collection: the articles are static HTML by the time a request arrives, and
 * the Function cannot read the frontmatter that produced them. So the build
 * writes what it knows into a small manifest, and the Function reads that.
 *
 * The manifest lists the *closed* posts rather than the open ones. Commenting is
 * on by default, so the list is normally empty, and a missing file therefore
 * means "everything is open" — the safe reading in both directions, since a
 * deployment that somehow lost the file would accept comments rather than
 * silently reject every one.
 *
 * ## Why enforce it at all, when the markup already hides the form
 *
 * Hiding the form is for the reader. Without a server-side check, `comments:
 * false` would mean "not shown" rather than "not accepted", and anyone posting
 * straight to the endpoint would have their comment stored on an article whose
 * author had closed it. The two halves have to agree or the field means nothing.
 */

/** The path the manifest is served from, relative to the site root. */
export const CLOSED_POSTS_PATH = "/comments-closed.json";

export interface ClosedPostsManifest {
  readonly schemaVersion: 1;
  /** Content paths, as the comment API receives them. */
  readonly closed: readonly string[];
}

/** Build the manifest from the ids of posts whose comments are off. */
export function buildClosedPostsManifest(
  closedPostIds: readonly string[],
): ClosedPostsManifest {
  return {
    schemaVersion: 1,
    // Sorted so the file is stable across builds and a diff means a real change.
    closed: [...closedPostIds].sort(),
  };
}

/**
 * Read a manifest, tolerating anything malformed.
 *
 * An unreadable manifest yields an empty set, because the alternative — failing
 * closed — would reject every comment on the site over a formatting mistake in a
 * file whose only job is to close a few articles. The articles that should be
 * closed are still closed in the markup, so the reader sees the right thing; the
 * cost of the tolerant reading is only that a determined poster could reach an
 * endpoint the author had closed.
 */
export function parseClosedPosts(value: unknown): ReadonlySet<string> {
  if (value === null || typeof value !== "object") return new Set();
  const closed = (value as { closed?: unknown }).closed;
  if (!Array.isArray(closed)) return new Set();
  return new Set(
    closed.filter((entry): entry is string => typeof entry === "string"),
  );
}
