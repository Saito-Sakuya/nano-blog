/**
 * The one visibility rule.
 *
 * Production pages, the search index, RSS, the sitemap, tag counts, series
 * listings and related articles all call `isPublicAt`. Any second
 * implementation would eventually disagree with this one, and the disagreement
 * would show up as a draft leaking into the feed.
 */

export interface VisibilityFields {
  readonly draft: boolean;
  /** Required for posts; directory indexes and pages have no publish date. */
  readonly publishedAt?: string | undefined;
}

/**
 * @param entry   Frontmatter carrying at least `draft`.
 * @param buildNow The single instant this build treats as "now".
 */
export function isPublicAt(entry: VisibilityFields, buildNow: Date): boolean {
  if (entry.draft) return false;

  if (entry.publishedAt !== undefined) {
    const published = Date.parse(entry.publishedAt);
    if (Number.isNaN(published)) return false;
    if (published > buildNow.getTime()) return false;
  }

  return true;
}
