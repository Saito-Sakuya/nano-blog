/**
 * Which optional renderers a body needs.
 *
 * Both the article layout and the standalone page layout decide, from the raw
 * Markdown source, whether to emit the Mermaid script tag and the KaTeX
 * stylesheet. Keeping the two tests here rather than inline in each layout is
 * what stops the two from disagreeing — a page whose formula arrives unstyled
 * because only the article layout knew how to look for one would be a silent
 * regression, not a visible break.
 */

/**
 * True when the source contains a `mermaid` fenced block.
 *
 * Anchored to the start of a line so the word appearing inside a paragraph —
 * or inside some other fenced block — does not count.
 */
export function hasMermaidDiagram(body: string): boolean {
  return /^\s*```mermaid\b/mu.test(body);
}

/**
 * True when the source contains a formula.
 *
 * A `$` followed by a non-space, non-`$` character opens an inline or block
 * formula. This deliberately errs towards loading the stylesheet: an
 * unnecessary request costs one small same-origin file, while an unstyled
 * formula is unreadable.
 */
export function hasMathFormula(body: string): boolean {
  return /\$\$?[^\s$]/u.test(body);
}
