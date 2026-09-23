import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { SITE_URL } from "./src/lib/site.js";
import {
  createMarkdownProcessor,
  shikiConfig,
  shikiExcludeLangs,
} from "./src/lib/markdown/plugins.js";

/**
 * Astro configuration.
 *
 * Notable choices, each tied to a locked requirement:
 *
 * - `output: 'static'` with no adapter: every public page is generated at build
 *   time and the site makes no request to private storage at runtime.
 * - `trailingSlash: 'always'`: one canonical form for every HTML URL.
 * - `build.inlineStylesheets: 'never'`: application styles ship as files so the
 *   Content-Security-Policy can forbid inline script and keep style handling
 *   predictable.
 * - `compressHTML: true`: Astro 7 changed the default to `'jsx'`, which strips
 *   whitespace between adjacent inline elements. That is wrong for a site whose
 *   body text mixes Chinese and Latin inline markup, so the previous behaviour
 *   is requested explicitly.
 * - `prefetch: false`: no global prefetching; navigation stays a plain link.
 */
export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "always",
  compressHTML: true,
  prefetch: false,

  build: {
    inlineStylesheets: "never",
    // Fixture builds write to their own directory so a leak cannot be masked by
    // a stale normal build sitting next to it.
    format: "directory",
    // Astro's own asset directory. `/assets/` is reserved for it, and
    // the cache policy in `public/_headers` is written against it.
    assets: "assets",
  },

  markdown: {
    processor: createMarkdownProcessor(),
    shikiConfig: {
      ...shikiConfig,
      transformers: [...shikiConfig.transformers],
    },
    syntaxHighlight: {
      type: "shiki",
      excludeLangs: [...shikiExcludeLangs],
    },
  },

  integrations: [
    mdx({
      // MDX inherits the Markdown processor above, so `.mdx` and `.md` share
      // one sanitizer, one heading-slug rule and one code-block pipeline.
      extendMarkdownConfig: true,
    }),
    sitemap({
      // `filter` is applied to absolute URLs. Paginated first pages and the 404
      // document are never emitted as pages in the first place, so the only
      // thing to exclude here is anything explicitly marked noindex.
      filter: (page) => !page.endsWith("/404/"),
    }),
  ],

  vite: {
    build: {
      // Astro inlines a component script when its chunk is small enough. An
      // inline `<script>` is exactly what `script-src 'self'` forbids, so
      // nothing may be inlined: every script must ship as a same-origin file.
      // This also keeps the door shut for `data:` URIs in stylesheets.
      assetsInlineLimit: 0,
      // Keep the Mermaid bundle separable so it is loaded only by pages that
      // actually contain a diagram.
      chunkSizeWarningLimit: 700,
    },
  },
});
