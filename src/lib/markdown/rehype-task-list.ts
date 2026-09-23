import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Give task-list checkboxes an accessible name.
 *
 * `remark-gfm` renders `- [x] done` as a disabled `<input type="checkbox">`
 * with no label of any kind, which axe reports as a form element without an
 * associated label. The checkbox is not decorative: whether an item is done is
 * the whole point of the list, so the state is what gets named.
 *
 * The label is written in the page language, matching the rest of the site.
 */
export function rehypeTaskList() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "input") return;

      const type = node.properties?.["type"];
      if (type !== "checkbox") return;

      // Only task lists: a checkbox an author wrote by hand in raw HTML keeps
      // whatever label they gave it.
      const checked = node.properties["checked"] === true;
      if (node.properties["aria-label"] === undefined) {
        node.properties["aria-label"] = checked ? "已完成" : "未完成";
      }
    });
  };
}
