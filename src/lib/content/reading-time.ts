import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * Estimated reading time.
 *
 *     max(1, ceil(CJK characters / 500 + Latin words / 220 + code lines / 30))
 *
 * The three terms are counted separately because they are read at very
 * different speeds. Putting them on one axis — a single "words per minute" —
 * would badly under-report a Chinese article or badly over-report a code-heavy
 * one.
 *
 * Frontmatter, image alt text, code-fence markers and component attributes are
 * all excluded: none of them is something a reader reads.
 */

const CJK_CHARACTER = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

const LATIN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu;

const parser = unified().use(remarkParse).use(remarkGfm);

export interface ReadingTime {
  /** Whole minutes, never below 1. */
  readonly minutes: number;
  /** Rendered form, e.g. `约 4 分钟`. */
  readonly label: string;
}

interface Counts {
  cjk: number;
  latinWords: number;
  codeLines: number;
}

/**
 * Collect the countable parts of a document body.
 */
function collectCounts(body: string): Counts {
  const counts: Counts = { cjk: 0, latinWords: 0, codeLines: 0 };
  const text: string[] = [];

  let tree: Root;
  try {
    tree = parser.parse(body) as Root;
  } catch {
    // A body that will not parse is reported by the renderer; reading time
    // simply falls back to the prose it can see.
    return countText(counts, body);
  }

  visit(tree, (node) => {
    if (node.type === "code") {
      const lines = node.value.split("\n");
      counts.codeLines += lines.filter((line) => line.trim().length > 0).length;
      return "skip";
    }

    if (node.type === "image" || node.type === "imageReference") {
      // Alt text is a description for assistive technology, not prose.
      return "skip";
    }

    if (node.type === "html") {
      // Component attributes are invisible; only the text between tags counts.
      text.push(node.value.replace(/<[^>]*>/gu, " "));
      return "skip";
    }

    if (node.type === "text" || node.type === "inlineCode") {
      text.push(node.value);
    }

    return undefined;
  });

  return countText(counts, text.join(" "));
}

function countText(counts: Counts, value: string): Counts {
  const cjkMatches = value.match(CJK_CHARACTER);
  counts.cjk += cjkMatches === null ? 0 : cjkMatches.length;

  const withoutCjk = value.replace(CJK_CHARACTER, " ");
  const latinMatches = withoutCjk.match(LATIN_WORD);
  counts.latinWords += latinMatches === null ? 0 : latinMatches.length;

  return counts;
}

export function readingTime(body: string): ReadingTime {
  const counts = collectCounts(body);
  const minutes = Math.max(
    1,
    Math.ceil(
      counts.cjk / 500 + counts.latinWords / 220 + counts.codeLines / 30,
    ),
  );
  return { minutes, label: `约 ${minutes} 分钟` };
}
