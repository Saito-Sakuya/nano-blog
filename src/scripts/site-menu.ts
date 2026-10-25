/**
 * The narrow-screen menu sheet.
 *
 * The sheet is a native popover: the menu button opens and closes it, Escape
 * and a click outside dismiss it, and focus returns to the button — all without
 * this script. What the browser cannot know is where the header ends. A banner
 * can sit above the header on local builds, and the header is sticky, so its
 * bottom edge moves; the sheet is placed against it each time it opens.
 *
 * It is also closed when the window widens past the tablet breakpoint, where
 * the menu button is hidden and an open sheet would have nothing to close it.
 */

const WIDE = "(min-width: 48rem)";

export function initSiteMenu(): void {
  const menu = document.querySelector<HTMLElement>("[data-site-menu]");
  const header = document.querySelector<HTMLElement>(".site-header");
  if (menu === null || header === null) return;

  menu.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    menu.style.insetBlockStart = `${String(header.getBoundingClientRect().bottom)}px`;
  });

  window.matchMedia(WIDE).addEventListener("change", (query) => {
    if (query.matches && menu.matches(":popover-open")) menu.hidePopover();
  });
}
