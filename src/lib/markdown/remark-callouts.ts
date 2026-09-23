import type { Blockquote, Paragraph, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/**
 * GitHub-style alert callouts:
 *
 *     > [!NOTE]
 *     > 内容
 *
 * Only the five fixed semantics are recognised. Anything else — including a
 * plausible-looking `[!DANGER]` — is deliberately left alone so it renders as
 * an ordinary blockquote; inventing a new style on the spot is not allowed.
 * `content:validate` reports those occurrences separately so the author finds
 * out without the build being broken for a cosmetic slip.
 */

export const CALLOUT_TYPES = [
  "NOTE",
  "TIP",
  "IMPORTANT",
  "WARNING",
  "CAUTION",
] as const;

export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** Accessible Chinese labels rendered as the callout's heading. */
export const CALLOUT_LABELS: Readonly<Record<CalloutType, string>> = {
  NOTE: "说明",
  TIP: "提示",
  IMPORTANT: "重要",
  WARNING: "警告",
  CAUTION: "注意",
};

const MARKER = /^\[!([A-Za-z]+)\]\s*\n?/u;

function isCalloutType(value: string): value is CalloutType {
  return (CALLOUT_TYPES as readonly string[]).includes(value);
}

/**
 * The marker and the first line of content share a single text node, so the
 * marker has to be sliced off rather than removed as its own node.
 */
function stripMarker(text: Text): void {
  text.value = text.value.replace(MARKER, "");
}

export function remarkCallouts() {
  return (tree: Root): void => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const [first] = node.children;
      if (!first || first.type !== "paragraph") return;

      const [firstChild] = first.children;
      if (!firstChild || firstChild.type !== "text") return;

      const match = MARKER.exec(firstChild.value);
      if (!match) return;

      const rawType = match[1] ?? "";
      if (!isCalloutType(rawType)) return; // Leave unknown markers as a plain quote.

      const type = rawType;
      stripMarker(firstChild);
      if (firstChild.value.length === 0) {
        first.children.shift();
      }
      // `> [!NOTE]` on its own line leaves an empty paragraph behind.
      if (first.children.length === 0) {
        node.children.shift();
      }

      const label: Paragraph = {
        type: "paragraph",
        data: {
          hName: "p",
          hProperties: { className: ["callout__label"] },
        },
        children: [{ type: "text", value: CALLOUT_LABELS[type] }],
      };

      node.children.unshift(label);

      node.data = {
        ...node.data,
        hName: "aside",
        hProperties: {
          className: ["callout", `callout--${type.toLowerCase()}`],
          dataCallout: type.toLowerCase(),
        },
      };
    });
  };
}
