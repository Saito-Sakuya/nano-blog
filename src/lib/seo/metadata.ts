import {
  canonicalUrl,
  OG_DEFAULT_CARD_PATH,
  OG_HEIGHT,
  OG_WIDTH,
  SITE_NAME,
  SITE_TAGLINE,
  isIndexable,
} from "../site.js";

/**
 * Page metadata.
 *
 * Every public page needs a unique title, a non-empty description, a canonical
 * URL and a complete Open Graph card. Those are assembled here so no page can
 * quietly ship a truncated body as its description or a title missing the site
 * name.
 */

export type OgType = "article" | "website";

export interface PageMetadata {
  /** Full document title, already including the site name where appropriate. */
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
  readonly ogType: OgType;
  readonly ogTitle: string;
  readonly ogDescription: string;
  readonly ogImage: string;
  readonly ogImageWidth: number;
  readonly ogImageHeight: number;
  /** `noindex, nofollow` for drafts, future posts, search results and 404s. */
  readonly robots: string;
  readonly publishedTime?: string | undefined;
  readonly modifiedTime?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
}

const NOINDEX_ROBOTS = "noindex, nofollow";
const INDEX_ROBOTS = "index, follow";

function robotsFor(noindex: boolean): string {
  return noindex || !isIndexable() ? NOINDEX_ROBOTS : INDEX_ROBOTS;
}

/**
 * The home page title is the site name alone; every other page reads
 * `Page title · nano-blog`.
 */
export function pageTitle(pageTitleText: string | null): string {
  return pageTitleText === null ? SITE_NAME : `${pageTitleText} · ${SITE_NAME}`;
}

export interface BuildMetadataInput {
  readonly title: string | null;
  readonly description: string;
  readonly pathname: string;
  readonly ogType?: OgType;
  readonly noindex?: boolean;
  readonly ogImage?: string | undefined;
  readonly ogTitle?: string | undefined;
  readonly ogDescription?: string | undefined;
  readonly publishedTime?: string | undefined;
  readonly modifiedTime?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
}

export function buildMetadata(input: BuildMetadataInput): PageMetadata {
  const description =
    input.description.trim().length > 0 ? input.description : SITE_TAGLINE;
  const title = pageTitle(input.title);
  // The path comes from `site.ts` rather than from `seo/og.ts`, which owns the
  // card's *contents*: importing that module would pull `sharp` and the
  // filesystem into the module graph of every page in the build.
  const ogImage = input.ogImage ?? OG_DEFAULT_CARD_PATH;

  return {
    title,
    description,
    canonical: canonicalUrl(input.pathname),
    ogType: input.ogType ?? "website",
    ogTitle: input.ogTitle ?? title,
    ogDescription: input.ogDescription ?? description,
    ogImage: ogImage.startsWith("http") ? ogImage : canonicalUrl(ogImage),
    ogImageWidth: OG_WIDTH,
    ogImageHeight: OG_HEIGHT,
    robots: robotsFor(input.noindex ?? false),
    publishedTime: input.publishedTime,
    modifiedTime: input.modifiedTime,
    keywords: input.keywords,
  };
}
