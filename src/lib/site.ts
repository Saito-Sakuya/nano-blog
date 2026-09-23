/**
 * Site identity constants.
 *
 * Every value here is either locked by the product specification or read from
 * the environment. Nothing is inferred, and nothing that belongs to the author
 * personally (real name, location, contact details, accounts) appears at all.
 *
 * This is the only place any of these values is written. A literal repeated at
 * a call site is a second source of truth, and the two always drift: the
 * language tag was spelled in six files, the author's name in three.
 */

/**
 * Read one build-time environment variable.
 *
 * `process` does not exist in a browser, and this module is reachable from
 * client scripts: `routing/urls.ts` imports `PAGE_SIZE` from here, and the
 * views and comments scripts import their endpoint helpers from there. A bare
 * `process.env.NAME` would then be a reference to an undefined global in the
 * reader's browser, so the lookup is guarded and the defaults below are what a
 * client-side import resolves to — which is what they should be, since none of
 * these values is used on the client for anything but a locale.
 */
function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

/** Canonical origin. No trailing slash. */
export const SITE_URL = normalizeOrigin(
  readEnv("SITE_URL") ?? "https://blog.example.invalid",
);

/**
 * The explicitly configured public media origin, if any.
 *
 * The fallback below is intentionally an unresolvable `.invalid` host. It is a
 * safe placeholder for generated URLs, but browsers must not be asked to warm
 * a connection to it: unlike image requests, a preconnect cannot be intercepted
 * by the browser-test routing layer and can make navigation wait on DNS.
 */
const CONFIGURED_MEDIA_ORIGIN = readEnv("PUBLIC_MEDIA_ORIGIN")?.trim();

/** Public origin that serves the media bucket. */
export const MEDIA_ORIGIN = normalizeOrigin(
  CONFIGURED_MEDIA_ORIGIN || "https://media.example.invalid",
);

/** Whether this build has a real media origin rather than the safe placeholder. */
export const HAS_CONFIGURED_MEDIA_ORIGIN = Boolean(CONFIGURED_MEDIA_ORIGIN);

/** IANA time zone used for every date decision made during a build. */
export const SITE_TIME_ZONE = readEnv("SITE_TIME_ZONE") ?? "Asia/Taipei";

/** Build environment. `production` is the only value that permits indexing. */
export type SiteEnv = "local" | "preview" | "production";

export const SITE_ENV: SiteEnv = parseSiteEnv(process.env["SITE_ENV"]);

export const SITE_NAME = "nano-blog";
export const SITE_AUTHOR = "Nano";
export const SITE_TAGLINE = "记录微小发现，也保存复杂思考。";
export const SITE_LANG = "zh-CN";

/**
 * The `og:locale` spelling of `SITE_LANG`.
 *
 * Open Graph writes a language tag with an underscore where BCP 47 has a
 * hyphen. Derived rather than repeated so the two can never name different
 * languages.
 */
export const SITE_OG_LOCALE = SITE_LANG.replace("-", "_");

/**
 * Dimensions of every generated Open Graph card.
 *
 * Read by the renderer that draws the cards *and* by the page metadata that
 * declares them: a card drawn at one size and declared as another is a
 * mismatch a social platform resolves by cropping the image.
 */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Directory every generated card is written to. */
export const OG_PATH_PREFIX = "/og/";

/** Key of the site-wide fallback card — the one a page without a cover uses. */
export const OG_DEFAULT_KEY = "default";

/** Public path of a card, given the key that names its file. */
export function ogCardPath(key: string): string {
  return `${OG_PATH_PREFIX}${key}.png`;
}

/** The fallback card itself, so metadata never has to spell the path. */
export const OG_DEFAULT_CARD_PATH = ogCardPath(OG_DEFAULT_KEY);

export const CONTENT_LICENSE_ID = "CC-BY-4.0";
export const CONTENT_LICENSE_URL =
  "https://creativecommons.org/licenses/by/4.0/";
export const CONTENT_LICENSE_LABEL = "CC BY 4.0";
export const CODE_LICENSE_LABEL = "MIT";

/** Articles per page across every paginated index. */
export const PAGE_SIZE = 10;

/** Prefix for every media path in the public bucket. */
export const MEDIA_PATH_PREFIX = "/media/";

export function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Site origins must be absolute http(s) URLs, but received ${JSON.stringify(value)}.`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Site origins must use http or https, but received ${JSON.stringify(value)}.`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Site origins must not contain credentials.");
  }
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `Site origins must not contain a path, query or fragment, but received ${JSON.stringify(value)}.`,
    );
  }

  return parsed.origin;
}

function parseSiteEnv(value: string | undefined): SiteEnv {
  if (value === "production" || value === "preview" || value === "local") {
    return value;
  }
  if (value === undefined || value === "") {
    return "local";
  }
  throw new Error(
    `SITE_ENV must be one of "local", "preview" or "production", but received ${JSON.stringify(value)}.`,
  );
}

/** True when this build may be indexed by search engines. */
export function isIndexable(): boolean {
  return SITE_ENV === "production";
}

/**
 * Resolve a site-relative path to an absolute canonical URL.
 */
export function canonicalUrl(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${SITE_URL}${path}`;
}
