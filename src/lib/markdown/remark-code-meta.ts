import type { Code, Root } from "mdast";
import { visit } from "unist-util-visit";

import { parseCodeFence } from "./code-fence.js";

/**
 * Parse and validate every fenced code block's info string.
 *
 * This plugin does not rewrite the fence. Its whole job is to be the place
 * where a malformed fence becomes a build failure: it runs early, while the
 * code is still an mdast node, so a reversed highlight range or an unclosed
 * `title="` stops the build with a message that names the problem instead of
 * silently rendering something the author did not write.
 *
 * The actual decoration happens later, inside the Shiki transformer, which
 * re-parses the same raw meta string with the same parser. That is safe
 * precisely because this pass has already proven the string is well formed.
 */
export function remarkCodeMeta() {
  return (tree: Root): void => {
    visit(tree, "code", (node: Code) => {
      // Shiki strips one trailing newline before highlighting, so a highlight
      // range is bounded against the same line count the renderer will see.
      const code = node.value.replace(/(?:\r\n|\r|\n)$/u, "");
      const lineCount = code.length === 0 ? 0 : code.split("\n").length;
      const info = [node.lang ?? "", node.meta ?? ""].join(" ").trim();
      if (info.length === 0) return;

      parseCodeFence(info, lineCount);
    });
  };
}
