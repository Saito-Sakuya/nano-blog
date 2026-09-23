import { initMediaFallbacks } from "./media.js";

/**
 * The small script every page loads.
 *
 * Deliberately tiny: a keyboard route to the search page, and the thumbnail
 * failure handler. Neither is page-specific, and both must be available
 * wherever the reader happens to be. Everything heavier is loaded only by the
 * pages that need it.
 */

const SEARCH_PATH = "/search/";

/** True when a keystroke belongs to whatever the reader is typing into. */
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;

  // A text selection means the reader is working with the text, not navigating.
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

function initSearchShortcut(): void {
  document.addEventListener("keydown", (event) => {
    const isSlash = event.key === "/";
    const isCtrlK =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";

    if (!isSlash && !isCtrlK) return;
    // Never steal a keystroke from a field the reader is typing in.
    if (isTypingContext(event.target)) return;
    if (event.altKey || (isSlash && (event.ctrlKey || event.metaKey))) return;

    event.preventDefault();

    if (window.location.pathname === SEARCH_PATH) {
      // Already here: focus the field instead of reloading the page.
      document.querySelector<HTMLInputElement>("[data-search-input]")?.focus();
      return;
    }

    // `focus=1` tells the search page to put the caret in the field once it has
    // loaded, so the keystroke lands where the reader intended.
    window.location.assign(`${SEARCH_PATH}?focus=1`);
  });
}

export function initGlobal(): void {
  initSearchShortcut();
  initMediaFallbacks();
}
