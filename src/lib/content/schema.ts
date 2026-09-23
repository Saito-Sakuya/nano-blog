import { z } from "astro/zod";

import { SITE_LANG } from "../site.js";

/**
 * Frontmatter schemas for the three content types.
 *
 * Every schema is strict: an unknown key is an error rather than something
 * quietly ignored, because a typo in a field name should never look like a
 * field that simply had no effect.
 *
 * Text rules are applied uniformly — NFC normalisation, no control characters,
 * no surrounding whitespace, and a length measured in Unicode code points
 * rather than UTF-16 units, so a Chinese title is not silently allowed to be
 * twice as long as a Latin one.
 */

/**
 * Binary control characters: C0 without tab, LF or CR, plus DEL and the C1
 * block.
 *
 * Spelled as escape sequences on purpose. A character class written with the
 * literal bytes is invisible in a diff, makes `git` call the file binary and
 * hides it from grep; `scripts/lib/unicode.ts` applies the same rule
 * arithmetically to paths and media bytes, and this must agree with it.
 */
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/u;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Path of a content-addressed media derivative in the public bucket. */
const COVER_SRC = new RegExp(`^/media/([0-9a-f]{64})/1600\\.webp$`, "u");

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * A required, well-formed text field with a code-point length budget.
 */
function boundedText(label: string, min: number, max: number) {
  return z.string().transform((raw, ctx) => {
    if (raw !== raw.trim()) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must not begin or end with whitespace.`,
      });
      return z.NEVER;
    }
    if (CONTROL_CHARACTERS.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must not contain control characters.`,
      });
      return z.NEVER;
    }
    const value = raw.normalize("NFC");
    const length = codePointLength(value);
    if (length < min || length > max) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must be ${min}–${max} characters long, but is ${length}.`,
      });
      return z.NEVER;
    }
    return value;
  });
}

/**
 * An ISO 8601 datetime with an explicit UTC offset.
 *
 * Two forms reach this schema because two libraries parse the same frontmatter,
 * and they disagree — not about the requirement, but about which copy of
 * `js-yaml` they resolve to:
 *
 * - The author tools in `scripts/content` import the project's own
 *   `js-yaml@5`, whose loader keeps `2026-09-15T09:00:00+08:00` as the exact
 *   string the author typed. That string is validated strictly here: an offset
 *   is required, so a bare `2026-09-15T09:00:00` or a date-only `2026-09-15` is
 *   rejected rather than guessed at.
 * - Astro's content loader parses frontmatter through
 *   `@astrojs/internal-helpers`, which depends on `js-yaml@4` — a different
 *   major version, installed beside it, that still implements the YAML 1.1
 *   timestamp type. The same text arrives here already converted to a `Date`.
 *
 * Both are normalised to an ISO string so the rest of the build handles one
 * type. The `z.date()` branch is therefore not defensive decoration: it is the
 * branch the production build actually takes, and this failure mode is real —
 * dropping it fails the build with
 * `updatedAt: Expected type "string", received "object"`.
 *
 * If Astro's helper ever resolves the same `js-yaml@5` the author tools use,
 * the timestamp type disappears from that path too and this union can collapse
 * to the string schema alone. Until then the version coupling is the reason.
 *
 * The stricter "explicit offset" rule is also enforced against the raw file
 * text by `content:validate`, which is the gate every release passes through
 * before it can be published — and that is the path where an unquoted YAML
 * timestamp is diagnosed rather than silently normalised.
 */
const offsetDateTime = z
  .union([z.iso.datetime({ offset: true }), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

/**
 * Tag entry. The `id` is the stable part used in URLs; the `label` is display
 * text and may be changed, as long as it stays consistent site-wide.
 */
export const tagSchema = z.strictObject({
  id: z.string().regex(KEBAB_ID, "Tag id must be lower-case ASCII kebab-case."),
  label: boundedText("Tag label", 1, 24),
});

export type Tag = z.output<typeof tagSchema>;

/**
 * Series membership. `order` positions the article inside its series.
 */
export const seriesSchema = z.strictObject({
  id: z
    .string()
    .regex(KEBAB_ID, "Series id must be lower-case ASCII kebab-case."),
  title: boundedText("Series title", 1, 60),
  order: z
    .number()
    .int("Series order must be a whole number.")
    .positive("Series order must be greater than zero."),
});

export type Series = z.output<typeof seriesSchema>;

/**
 * Cover image. The source must be a 1600×900 derivative in the media bucket;
 * the dimensions are asserted rather than read so a mismatch between
 * frontmatter and the media index is caught rather than rendered.
 */
export const coverSchema = z.strictObject({
  src: z
    .string()
    .regex(
      COVER_SRC,
      "Cover src must be /media/<64-character-source-sha256>/1600.webp.",
    ),
  alt: boundedText("Cover alt", 4, 160),
  width: z.literal(1600),
  height: z.literal(900),
  credit: boundedText("Cover credit", 1, 200).optional(),
});

export type Cover = z.output<typeof coverSchema>;

/** Fields shared by posts and standalone pages. */
const sharedFields = {
  lang: z.literal(SITE_LANG).default(SITE_LANG),
  license: z.literal("CC-BY-4.0").default("CC-BY-4.0"),
  draft: z.boolean().default(false),
};

/** An `https:` URL, used for `canonicalUrl`. */
const httpsUrl = z
  .url({ protocol: /^https$/u, error: "URL must use https." })
  .max(2048);

/**
 * A published article.
 */
export const postSchema = z
  .strictObject({
    ...sharedFields,
    title: boundedText("Title", 1, 80),
    description: boundedText("Description", 40, 160),
    publishedAt: offsetDateTime,
    updatedAt: offsetDateTime.optional(),
    tags: z
      .array(tagSchema)
      .max(5, "An article may carry at most 5 tags.")
      .default([])
      .refine(
        (tags) => new Set(tags.map((tag) => tag.id)).size === tags.length,
        "Tag ids must be unique within an article.",
      ),
    series: seriesSchema.optional(),
    cover: coverSchema,
    canonicalUrl: httpsUrl.optional(),
    toc: z.enum(["auto", "always", "never"]).default("auto"),
    /*
     * Whether the article accepts comments.
     *
     * Defaulted to `true` because commenting is on by default and the common
     * case should not need a field; an article that wants to close its comments
     * says `comments: false`. A closed article renders no comment section and
     * loads no comment script, and its endpoint refuses submissions — so the
     * switch is enforced on both sides rather than only in the markup.
     */
    comments: z.boolean().default(true),
    ogTitle: boundedText("ogTitle", 1, 70).optional(),
    ogDescription: boundedText("ogDescription", 40, 160).optional(),
  })
  .refine(
    (post) =>
      post.updatedAt === undefined ||
      Date.parse(post.updatedAt) >= Date.parse(post.publishedAt),
    "updatedAt must not be earlier than publishedAt.",
  );

export type PostFrontmatter = z.output<typeof postSchema>;

/**
 * A standalone page, normally `pages/about.md`.
 */
export const pageSchema = z.strictObject({
  ...sharedFields,
  title: boundedText("Title", 1, 80),
  description: boundedText("Description", 40, 160),
  updatedAt: offsetDateTime.optional(),
  cover: coverSchema.optional(),
  canonicalUrl: httpsUrl.optional(),
  noindex: z.boolean().default(false),
});

export type PageFrontmatter = z.output<typeof pageSchema>;

/**
 * A directory index (`_index.md`). Its description budget is shorter than a
 * post's, because it is a navigational blurb rather than a summary.
 */
export const indexSchema = z.strictObject({
  lang: z.literal(SITE_LANG).default(SITE_LANG),
  license: z.literal("CC-BY-4.0").default("CC-BY-4.0"),
  draft: z.boolean().default(false),
  title: boundedText("Title", 1, 60),
  description: boundedText("Description", 20, 160),
  order: z.number().int("Index order must be a whole number.").default(0),
  cover: coverSchema.optional(),
});

export type IndexFrontmatter = z.output<typeof indexSchema>;
