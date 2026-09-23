import type { Element } from "hast";

import { parseCodeFence, type CodeFenceMeta } from "./code-fence.js";

/**
 * A Shiki transformer that decorates highlighted code blocks with the
 * information carried by the fence's info string.
 *
 * Why a transformer rather than a rehype plugin: Astro runs user rehype
 * plugins *after* `rehypeShiki`, and Shiki replaces the whole `<pre>` node, so
 * anything a rehype plugin attached beforehand is discarded. A transformer is
 * the only hook that sits inside highlighting and can still see the fence.
 *
 * Two details of the current Shiki v4 API shape this file, both verified
 * against the installed package rather than assumed:
 *
 * - The fence's info string is *not* parsed by Shiki. It arrives untouched on
 *   `this.options.meta.__raw`. Parsing is therefore entirely this project's
 *   business, which is why `parseCodeFence` is the single source of truth for
 *   both the validation pass and this decoration pass.
 * - `this.meta` is an empty object reserved for identity tracking. It never
 *   carries the info string, and reading it would silently yield nothing.
 */

interface MetaCarrier {
  __raw?: unknown;
}

interface TransformerContext {
  options?: { meta?: MetaCarrier };
  addClassToHast?: (node: Element, className: string | string[]) => Element;
}

interface ShikiTransformer {
  name: string;
  pre?: (this: TransformerContext, node: Element) => void;
  line?: (this: TransformerContext, node: Element, line: number) => void;
}

/**
 * Parsing is pure and the same fence is parsed once per line hook, so results
 * are memoised by the raw info string.
 */
const parsedCache = new Map<string, CodeFenceMeta>();

function parseCached(raw: string): CodeFenceMeta {
  const cached = parsedCache.get(raw);
  if (cached !== undefined) return cached;
  const parsed = parseCodeFence(raw);
  parsedCache.set(raw, parsed);
  return parsed;
}

function readRawMeta(context: TransformerContext): string | null {
  const raw = context.options?.meta?.__raw;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function transformerCodeMeta(): ShikiTransformer {
  return {
    name: "nano-blog:code-meta",

    pre(node) {
      const raw = readRawMeta(this);
      if (raw === null) return;

      // Already validated in the remark pass, so a throw here would mean a bug
      // rather than bad authoring.
      const meta = parseCached(raw);

      node.properties = node.properties ?? {};
      // Astro's own transformer runs before this one and has already set
      // `dataLanguage`; the title and line-number flag are ours to add.
      if (meta.title !== null) {
        node.properties.dataTitle = meta.title;
      }
      if (meta.showLineNumbers) {
        node.properties.dataLineNumbers = "true";
      }
      if (meta.highlight.length > 0) {
        node.properties.dataHighlight = meta.highlight.join(",");
      }
    },

    /**
     * Shiki reports a 1-based line number here, so the zero-based indexes the
     * fence parser produces are shifted back into its numbering.
     */
    line(node, line) {
      const raw = readRawMeta(this);
      if (raw === null) return;

      const meta = parseCached(raw);
      if (meta.highlight.includes(line - 1)) {
        this.addClassToHast?.(node, "line--highlighted");
      }
    },
  };
}
