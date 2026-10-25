/**
 * The view-transition name a post's title carries.
 *
 * The same name on the list row's title and on the article's heading is what
 * lets the browser carry the one into the other when the reader follows the
 * link. Names must be unique on a page and must be CSS identifiers, so the id
 * (which contains slashes) is hashed rather than used directly.
 *
 * The name goes on the heading element, never on the link inside it: a title
 * that wraps makes the inline link a fragmented box, and a fragmented box with
 * a transition name makes the browser abandon the whole transition.
 */
export function titleTransitionName(id: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return `post-title-${(value >>> 0).toString(36)}`;
}

/** The inline style that applies the name. */
export function titleTransitionStyle(id: string): string {
  return `view-transition-name: ${titleTransitionName(id)}`;
}
