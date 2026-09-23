import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

import { indexSchema, pageSchema, postSchema } from "./lib/content/schema.js";
import { CONTENT_RUNTIME_DIR, ROOT_INDEX_ID } from "./lib/content/paths.js";

/**
 * Content collections.
 *
 * The build never reads the author's workspace or the R2 bucket directly: a
 * step before Astro starts materialises exactly one source — empty, workspace,
 * fixtures or a pulled R2 release — into `.ani-content/runtime/content`. These
 * loaders read only that directory, so the four content modes cannot leak into
 * one another and a fixture build is structurally incapable of picking up real
 * content.
 *
 * `generateId` is supplied explicitly rather than left to the default slugger,
 * because entry ids are a public contract here: `dev/web/a` must stay
 * `dev/web/a` so that routes, redirects and the R2 manifest all agree.
 */

const postsBase = new URL("posts/", CONTENT_RUNTIME_DIR);
const pagesBase = new URL("pages/", CONTENT_RUNTIME_DIR);

function stripMarkdownExtension(entry: string): string {
  return entry.replace(/\.mdx?$/u, "");
}

const posts = defineCollection({
  loader: glob({
    base: postsBase,
    pattern: ["**/*.md", "**/*.mdx", "!**/_index.md"],
    generateId: ({ entry }) => stripMarkdownExtension(entry),
  }),
  schema: postSchema,
});

const postIndexes = defineCollection({
  loader: glob({
    base: postsBase,
    pattern: "**/_index.md",
    generateId: ({ entry }) => {
      const withoutExtension = stripMarkdownExtension(entry);
      const directory = withoutExtension.replace(/(?:^|\/)_index$/u, "");
      return directory.length === 0 ? ROOT_INDEX_ID : directory;
    },
  }),
  schema: indexSchema,
});

const pages = defineCollection({
  loader: glob({
    base: pagesBase,
    pattern: ["**/*.md", "**/*.mdx"],
    generateId: ({ entry }) => stripMarkdownExtension(entry),
  }),
  schema: pageSchema,
});

export const collections = { posts, postIndexes, pages };
