/**
 * Related-article scoring.
 *
 * Kept as a pure module — no collection loading, no Astro imports — so the
 * ranking rule can be unit tested directly rather than inferred from a rendered
 * page.
 */

/** The fields scoring needs. Both `PostView` and a test double satisfy it. */
export interface ScorablePost {
  readonly id: string;
  readonly sourcePath: string;
  readonly data: {
    readonly publishedAt: string;
    readonly tags: readonly { readonly id: string; readonly label: string }[];
    readonly series?: { readonly id: string } | undefined;
  };
}

/**
 * Score two articles for relatedness.
 *
 * Same series +20; each shared tag +10; one point off for every whole 365 days
 * of separation, to a maximum of 5. A non-positive score means "not related".
 */
export function relatedScore(
  current: ScorablePost,
  candidate: ScorablePost,
): number {
  let score = 0;

  const currentSeries = current.data.series?.id;
  const candidateSeries = candidate.data.series?.id;
  if (currentSeries !== undefined && currentSeries === candidateSeries) {
    score += 20;
  }

  const currentTags = new Set(current.data.tags.map((tag) => tag.id));
  for (const tag of candidate.data.tags) {
    if (currentTags.has(tag.id)) score += 10;
  }

  const daysApart =
    Math.abs(
      Date.parse(current.data.publishedAt) -
        Date.parse(candidate.data.publishedAt),
    ) /
    (1000 * 60 * 60 * 24);
  score -= Math.min(5, Math.floor(daysApart / 365));

  return score;
}

/**
 * Up to `limit` related articles, best first.
 *
 * Ties are broken by publication date descending and then by path, so the
 * result is deterministic and does not depend on collection iteration order.
 */
export function relatedPosts<T extends ScorablePost>(
  current: T,
  all: readonly T[],
  limit = 3,
): T[] {
  return all
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => ({
      candidate,
      score: relatedScore(current, candidate),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byDate =
        Date.parse(b.candidate.data.publishedAt) -
        Date.parse(a.candidate.data.publishedAt);
      if (byDate !== 0) return byDate;
      return a.candidate.sourcePath < b.candidate.sourcePath ? -1 : 1;
    })
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
