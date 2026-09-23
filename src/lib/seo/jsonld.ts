import {
  CONTENT_LICENSE_URL,
  SITE_AUTHOR,
  SITE_LANG,
  SITE_NAME,
  SITE_URL,
  canonicalUrl,
} from "../site.js";
import type { PostFrontmatter } from "../content/schema.js";

/**
 * `BlogPosting` structured data.
 *
 * Only facts the site actually holds appear here. The author is a `Person`
 * named "Nano" with no URL, avatar or job title, because none of those exist and
 * inventing them would be publishing a false claim about a real person.
 */

/**
 * Serialise structured data for an inline `<script type="application/ld+json">`.
 *
 * `JSON.stringify` alone is not safe for that position. The HTML parser ends a
 * `<script>` element at the first `</script` in its text, whatever the script's
 * type, and it does not care that the bytes are JSON: a frontmatter title of
 * `</script><meta http-equiv="refresh" content="0;url=//evil">` closes the
 * element and the markup after it becomes part of the document head. Length
 * limits do not help — they bound how long a title is, not which characters it
 * contains. So every character that can matter to a parser is written as a JSON
 * escape, which parses back to exactly the same string.
 *
 * `&` and `>` are escaped with `<` because a title is also copied into other
 * HTML contexts by other tools, and because the HTML spec's own suggestion for
 * this case ("Ambiguous ampersand") is to escape all three.
 *
 * U+2028 and U+2029 are escaped for the JavaScript parser rather than the HTML
 * one: both are legal inside a JSON string but were line terminators in
 * JavaScript before ES2019, so a consumer that evaluates the payload as script
 * would otherwise break on them.
 *
 * The escapes are applied to the serialised text, not to the values, so nested
 * keys and arrays are covered by the same pass and nothing can be double
 * encoded.
 */
const SCRIPT_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => SCRIPT_ESCAPES[character] ?? character,
  );
}

export interface BlogPostingInput {
  readonly data: PostFrontmatter;
  readonly id: string;
  readonly url: string;
  readonly description: string;
  readonly imageUrl: string;
}

export function blogPostingJsonLd(
  input: BlogPostingInput,
): Record<string, unknown> {
  const { data } = input;

  const json: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: data.ogTitle ?? data.title,
    description: data.ogDescription ?? input.description,
    datePublished: data.publishedAt,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": canonicalUrl(input.url),
    },
    image: [input.imageUrl],
    inLanguage: data.lang,
    author: {
      "@type": "Person",
      name: SITE_AUTHOR,
    },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      logo: {
        "@type": "ImageObject",
        url: canonicalUrl("/favicon.svg"),
      },
    },
    license: CONTENT_LICENSE_URL,
    isAccessibleForFree: true,
  };

  if (data.updatedAt !== undefined) {
    json["dateModified"] = data.updatedAt;
  }

  const keywords = data.tags.map((tag) => tag.label);
  if (keywords.length > 0) {
    json["keywords"] = keywords;
  }

  return json;
}

/** The site itself, for the home page. */
export function blogJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: SITE_NAME,
    url: SITE_URL,
    inLanguage: SITE_LANG,
    author: { "@type": "Person", name: SITE_AUTHOR },
  };
}
