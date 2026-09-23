/**
 * Bucket defaults and cache policy.
 *
 * Two buckets with strictly separated jobs: the content bucket is private and
 * holds immutable releases plus the one mutable pointer; the media bucket is
 * public and holds content-addressed derivatives. Nothing in the blog's request
 * path ever reads the private one.
 */

export const DEFAULT_CONTENT_BUCKET = "nano-blog-content";
export const DEFAULT_MEDIA_BUCKET = "nano-blog-media";

/**
 * Release objects never change once written, so they may be cached forever.
 * `private` because the bucket is not public.
 */
export const IMMUTABLE_RELEASE_CACHE_CONTROL =
  "private, max-age=31536000, immutable";

/**
 * Hashed media never changes either, and these are served publicly.
 */
export const IMMUTABLE_MEDIA_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

/**
 * `meta.json` is content-addressed too, but it also carries fields an author
 * may correct — alt text, credit — so it may be cached but must not be
 * immutable.
 */
export const MEDIA_META_CACHE_CONTROL =
  "public, max-age=86400, must-revalidate";
