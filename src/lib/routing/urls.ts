import { PAGE_SIZE } from "../site.js";

/**
 * Every URL this site emits.
 *
 * Centralised so that canonical URLs, RSS links, sitemap entries, breadcrumbs
 * and in-page navigation can never disagree about the shape of a path. All
 * HTML URLs carry a trailing slash; only files such as `rss.xml` and
 * `robots.txt` do not.
 */

/** Page 1 is the bare index; there is never a `/page/1/`. */
function pageSuffix(page: number): string {
  return page <= 1 ? "" : `page/${page}/`;
}

export function postUrl(id: string): string {
  return `/posts/${id}/`;
}

/** A posts directory, given its path segments. */
export function directoryUrl(segments: readonly string[]): string {
  return segments.length === 0 ? "/posts/" : `/posts/${segments.join("/")}/`;
}

/** A paginated posts directory. */
export function directoryPageUrl(
  segments: readonly string[],
  page: number,
): string {
  return `${directoryUrl(segments)}${pageSuffix(page)}`;
}

export function homePageUrl(page: number): string {
  return page <= 1 ? "/" : `/page/${page}/`;
}

export function archivePageUrl(page: number): string {
  return page <= 1 ? "/archive/" : `/archive/page/${page}/`;
}

export function tagsIndexUrl(): string {
  return "/tags/";
}

export function tagUrl(id: string): string {
  return `/tags/${id}/`;
}

export function tagPageUrl(id: string, page: number): string {
  return `${tagUrl(id)}${pageSuffix(page)}`;
}

export function seriesIndexUrl(): string {
  return "/series/";
}

export function seriesUrl(id: string): string {
  return `/series/${id}/`;
}

export function seriesPageUrl(id: string, page: number): string {
  return `${seriesUrl(id)}${pageSuffix(page)}`;
}

export function pageUrl(id: string): string {
  return `/${id}/`;
}

/**
 * The API endpoint for a page's comments.
 *
 * A content path may contain slashes, and the endpoint's route is a catch-all
 * segment, so the value is percent-encoded: `dev/web/a` must arrive as one
 * parameter rather than as three path segments. `encodeURIComponent` leaves no
 * slash unescaped, which is what makes that true.
 */
export function commentsApiPath(postId: string): string {
  return `/api/comments/${encodeURIComponent(postId)}`;
}

/** The API endpoint for a page's view count. */
export function viewsApiPath(postId: string): string {
  return `/api/views/${encodeURIComponent(postId)}`;
}

export const searchUrl = "/search/";
export const aboutUrl = "/about/";
export const rssUrl = "/rss.xml";
export const postsIndexUrl = "/posts/";

export interface PaginationLink {
  readonly page: number;
  readonly url: string;
  readonly current: boolean;
}

export interface Pagination {
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  /** `null` on the first page, so no dead control is ever rendered. */
  readonly previousUrl: string | null;
  readonly nextUrl: string | null;
  readonly links: readonly PaginationLink[];
}

/**
 * Build pagination metadata for a list.
 *
 * A single page produces no pagination at all rather than a lone page-1 link.
 */
export function paginate(
  totalItems: number,
  page: number,
  urlForPage: (page: number) => string,
  pageSize: number = PAGE_SIZE,
): Pagination {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const links: PaginationLink[] = [];
  for (let index = 1; index <= totalPages; index += 1) {
    links.push({
      page: index,
      url: urlForPage(index),
      current: index === page,
    });
  }

  return {
    page,
    totalPages,
    totalItems,
    previousUrl: page > 1 ? urlForPage(page - 1) : null,
    nextUrl: page < totalPages ? urlForPage(page + 1) : null,
    links,
  };
}

/** Slice one page out of a list. */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  pageSize: number = PAGE_SIZE,
): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** The page numbers a paginated route must generate. */
export function pageNumbers(
  totalItems: number,
  pageSize: number = PAGE_SIZE,
): number[] {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}
