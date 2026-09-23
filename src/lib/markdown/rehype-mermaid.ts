import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";

/** Mermaid diagram kinds, used to describe a diagram in one short phrase. */
const DIAGRAM_KINDS: Readonly<Record<string, string>> = {
  graph: "流程图",
  flowchart: "流程图",
  sequencediagram: "时序图",
  classdiagram: "类图",
  statediagram: "状态图",
  erdiagram: "实体关系图",
  journey: "用户旅程图",
  gantt: "甘特图",
  pie: "饼图",
  quadrantchart: "象限图",
  requirementdiagram: "需求图",
  gitgraph: "Git 分支图",
  mindmap: "思维导图",
  timeline: "时间线图",
  sankey: "桑基图",
  xychart: "折线图",
  block: "块图",
};

/**
 * A short accessible name for a diagram, derived from its own first line.
 *
 * `graph TD;` becomes "流程图", an unrecognised directive falls back to
 * "图表", and an empty block still gets a name so the element is never
 * unlabelled.
 */
function diagramLabel(source: string): string {
  const firstLine =
    source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  const keyword = firstLine.split(/[\s;{]/u)[0]?.toLowerCase() ?? "";
  const kind = DIAGRAM_KINDS[keyword];
  return kind === undefined ? "图表" : `图表：${kind}`;
}

/**
 * Turn a `mermaid` fenced block into an enhanced diagram holder.
 *
 * The diagram's source stays in the document as visible text. That is the
 * no-JavaScript experience and the failure experience alike: the reader sees
 * the diagram definition rather than an empty box. The client script hides the
 * source only once it has successfully drawn the diagram.
 *
 * Mermaid is excluded from Shiki, so the raw source is still intact here.
 *
 * The drawing area is `role="img"`, so it needs an accessible name: a `figure`
 * with `role="img"` and no name is a serious axe violation (`role-img-alt`),
 * and a screen reader would otherwise announce an unlabelled graphic. The name
 * is derived from the diagram's own source — its first non-empty line, which is
 * the Mermaid directive that says what kind of diagram it is — because the
 * document provides nothing better and inventing a description would be worse
 * than describing what is actually there. The `pre` that follows carries the
 * full source, so the name is a label rather than the only access to the
 * content.
 */
export function rehypeMermaid() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || parent === undefined || index === undefined)
        return;

      const [code] = node.children;
      if (
        code === undefined ||
        code.type !== "element" ||
        code.tagName !== "code"
      )
        return;

      const classes = code.properties?.["className"];
      const isMermaid =
        Array.isArray(classes) &&
        classes.some((value) => value === "language-mermaid");
      if (!isMermaid) return;

      const [text] = code.children;
      if (text === undefined || text.type !== "text") return;

      const source: Text = { type: "text", value: text.value };
      const label = diagramLabel(text.value);

      const holder: Element = {
        type: "element",
        tagName: "figure",
        properties: {
          className: ["mermaid-block"],
          dataMermaid: "",
        },
        children: [
          {
            type: "element",
            tagName: "div",
            properties: {
              className: ["mermaid-block__diagram"],
              dataMermaidTarget: "",
              role: "img",
              ariaLabel: label,
            },
            children: [],
          },
          {
            type: "element",
            tagName: "pre",
            properties: {
              className: ["mermaid-block__source"],
              dataMermaidSource: "",
              tabIndex: 0,
            },
            children: [
              {
                type: "element",
                tagName: "code",
                properties: {},
                children: [source],
              },
            ],
          },
          {
            type: "element",
            tagName: "p",
            properties: {
              className: ["mermaid-block__status"],
              dataMermaidStatus: "",
              hidden: true,
            },
            children: [
              { type: "text", value: "图表无法渲染，以下为图表源码。" },
            ],
          },
        ],
      };

      parent.children[index] = holder;
    });
  };
}
