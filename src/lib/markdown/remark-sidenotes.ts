import type { Paragraph, Root } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Markdown sidenotes, written as a container directive:
 *
 *     :::sidenote[可选标签]
 *     边注正文，支持 Markdown。
 *     :::
 *
 * `remark-directive` represents a bracketed label as a leading paragraph
 * carrying `data.directiveLabel`, while `{label="…"}` lands in `attributes`.
 * Both spellings are accepted, and the label paragraph is removed from the
 * children so it does not also render as body text.
 *
 * Numbering is applied in the browser, in one pass over every `aside.sidenote`
 * on the page. Doing it there rather than here means the Markdown directive and
 * the MDX `<Sidenote>` component cannot drift apart: an MDX component cannot
 * know its position in the document at render time, so a server-side counter
 * would have to be maintained twice and would disagree the moment one path
 * changed.
 */

const NAME = "sidenote";

export function remarkSidenotes() {
  return (tree: Root): void => {
    visit(tree, "containerDirective", (node) => {
      if (node.name !== NAME) return;

      const { attributes } = node;
      let label: string | null =
        typeof attributes?.label === "string" && attributes.label.length > 0
          ? attributes.label
          : null;

      // `:::sidenote[标签]` puts the label in a leading label paragraph.
      const [first] = node.children;
      if (
        first &&
        first.type === "paragraph" &&
        first.data?.directiveLabel === true
      ) {
        const text = first.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("")
          .trim();
        if (text.length > 0 && label === null) {
          label = text;
        }
        node.children.shift();
      }

      const children: Paragraph[] = [];
      if (label !== null) {
        children.push({
          type: "paragraph",
          data: {
            hName: "span",
            hProperties: { className: ["sidenote__label"] },
          },
          children: [{ type: "text", value: label }],
        });
      }

      node.data = {
        ...node.data,
        hName: "aside",
        hProperties: {
          className: ["sidenote"],
          role: "note",
        },
      };

      // The marker is filled in with the note's number in the browser, so its
      // position is decided by the same pass that numbers MDX notes.
      const marker: Paragraph = {
        type: "paragraph",
        data: {
          hName: "span",
          hProperties: { className: ["sidenote__marker"], ariaHidden: "true" },
        },
        children: [{ type: "text", value: "" }],
      };

      node.children.unshift(...children, marker);
    });
  };
}
