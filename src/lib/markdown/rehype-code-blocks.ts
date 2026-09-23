import type { Element, ElementContent, Properties, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Wrap each highlighted code block in the frame the stylesheet expects.
 *
 * Shiki emits a bare `<pre class="astro-code">`. Everything the reader sees
 * around a code block — the language label, an optional title, the copy button
 * — hangs off a `.code-block` ancestor, which Shiki does not create. The Shiki
 * transformer can annotate the `<pre>` with data attributes, but it cannot put
 * a wrapper around itself.
 *
 * This runs as a *user* rehype plugin, which Astro invokes after `rehypeShiki`,
 * so the highlighted markup already exists and the attributes the transformer
 * set are already on the node.
 */

/**
 * Whether an element carries a class.
 *
 * Two quirks have to be handled together, and missing either one makes this
 * silently match nothing:
 *
 * - The property may be an array of names or a single space-separated string.
 *   Nodes this project builds use the array form; Astro's Shiki wrapper assigns
 *   a plain string.
 * - The key may be `className`, which is what hast normalises to, or the raw
 *   `class`, which is what Astro's Shiki wrapper actually writes.
 */
export function hasClass(node: Element, name: string): boolean {
  const properties = node.properties;
  if (properties === undefined) return false;

  for (const key of ["className", "class"] as const) {
    const value = properties[key];
    if (Array.isArray(value)) {
      if (value.some((entry) => entry === name)) return true;
    } else if (
      typeof value === "string" &&
      value.split(/\s+/u).includes(name)
    ) {
      return true;
    }
  }
  return false;
}

export function rehypeCodeBlocks() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || parent === undefined || index === undefined)
        return;
      if (!hasClass(node, "astro-code")) return;

      const language = node.properties["dataLanguage"];
      const title = node.properties["dataTitle"];
      const lineNumbers = node.properties["dataLineNumbers"];

      // The wrapper carries the same data attributes as the `<pre>`, because the
      // stylesheet's line-number and highlight rules are written against
      // `.code-block[data-line-numbers]`.
      const wrapperProperties: Properties = {
        className: ["code-block"],
        dataCodeBlock: "",
      };
      if (typeof language === "string")
        wrapperProperties["dataLanguage"] = language;
      if (typeof title === "string") wrapperProperties["dataTitle"] = title;
      if (lineNumbers === "true") wrapperProperties["dataLineNumbers"] = "true";

      const bar: Element = {
        type: "element",
        tagName: "div",
        properties: { className: ["code-block__bar"] },
        children: [
          ...(typeof title === "string"
            ? [
                {
                  type: "element" as const,
                  tagName: "span",
                  properties: { className: ["code-block__title"] },
                  children: [{ type: "text" as const, value: title }],
                },
              ]
            : []),
          ...(typeof language === "string"
            ? [
                {
                  type: "element" as const,
                  tagName: "span",
                  properties: { className: ["code-block__lang"] },
                  children: [{ type: "text" as const, value: language }],
                },
              ]
            : []),
          {
            type: "element",
            tagName: "button",
            properties: {
              className: ["code-block__copy"],
              type: "button",
              dataCopyCode: "",
            },
            children: [{ type: "text", value: "复制" }],
          },
          {
            type: "element",
            tagName: "span",
            properties: {
              className: ["code-block__status"],
              dataCopyStatus: "",
            },
            children: [],
          },
        ],
      };

      const frame: Element = {
        type: "element",
        tagName: "div",
        properties: { className: ["code-block__frame"] },
        children: [bar, node as ElementContent],
      };

      const wrapper: Element = {
        type: "element",
        tagName: "div",
        properties: wrapperProperties,
        children: [frame],
      };

      parent.children[index] = wrapper;
    });
  };
}
