import type { APIRoute, GetStaticPaths } from "astro";

import { loadSite } from "../../lib/content/collections.js";
import {
  OG_DEFAULT_KEY,
  ogKeyForCover,
  renderCoverCard,
  renderDefaultCard,
} from "../../lib/seo/og.js";

/**
 * Build-time Open Graph cards.
 *
 * One card per distinct cover, plus the site-wide default. Keys are derived
 * from the cover path, so two articles sharing a cover share a card and
 * changing a cover produces a new file rather than a stale one.
 *
 * A failure here fails the build. Emitting a blank or 1×1 placeholder would
 * mean every social embed of the site silently degraded, which is worse than a
 * loud build error.
 */

/**
 * Astro's `Props` is an index-signature type, and a plain interface is not
 * assignable to it — the extra index signature is what makes the concrete
 * shape usable in both directions.
 */
type CardProps = {
  coverSrc: string | null;
  [key: string]: unknown;
};

/** One generated card. The two kinds have different props, so the array is
 * built up as one union rather than inferred per branch. */
interface CardPath {
  params: { key: string };
  props: CardProps;
}

export const getStaticPaths: GetStaticPaths = async () => {
  const site = await loadSite();

  const byKey = new Map<string, string>();
  for (const post of site.posts) {
    byKey.set(ogKeyForCover(post.data.cover.src), post.data.cover.src);
  }

  const paths: CardPath[] = [
    {
      params: { key: OG_DEFAULT_KEY },
      props: { coverSrc: null },
    },
  ];

  for (const [key, coverSrc] of byKey) {
    paths.push({ params: { key }, props: { coverSrc } });
  }

  return paths;
};

export const GET: APIRoute<CardProps> = async ({ props }) => {
  const png =
    props.coverSrc === null
      ? await renderDefaultCard()
      : await renderCoverCard(props.coverSrc);

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Card file names contain a digest of their inputs, so a card is
      // immutable for as long as its URL exists.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
