/**
 * Media failure handling.
 *
 * Every content image sits in a frame that already contains its own fallback: a
 * solid panel carrying the image's description. This script only marks the
 * frame once the image has failed, and the stylesheet does the rest.
 *
 * Why a panel rather than the browser's default: a broken `<img>` renders the
 * user agent's broken-image glyph and a stray run of alt text, which reads as a
 * broken page. The panel keeps the frame's exact size — the layout never moves
 * — and keeps the description available to assistive technology, because the
 * image is removed from the accessibility tree and the panel takes its place
 * with the same label.
 */

const FRAME = "[data-media-frame]";
const IMAGE = "img[data-media-image]";

function markFailed(image: HTMLImageElement): void {
  const frame = image.closest<HTMLElement>(FRAME);
  if (frame === null) return;

  frame.dataset["state"] = "failed";

  const fallback = frame.querySelector<HTMLElement>("[data-media-fallback]");
  const description = image.getAttribute("alt") ?? "";
  if (
    fallback !== null &&
    description.trim().length > 0 &&
    fallback.childElementCount === 0
  ) {
    // The panel speaks for the image it replaces, so the description is not
    // lost when the image leaves the accessibility tree.
    fallback.setAttribute("role", "img");
    fallback.setAttribute("aria-label", description);
  }

  image.setAttribute("aria-hidden", "true");
}

/**
 * Mark an image as still in flight, so it can fade in rather than appear.
 *
 * Only images that have genuinely not finished are marked. An image already in
 * the cache is left alone and paints immediately, and — critically — nothing is
 * ever hidden unless this script is running to reveal it again. Without
 * JavaScript every image is simply visible, which is the correct fallback.
 */
function markLoading(image: HTMLImageElement): void {
  image.dataset["mediaLoading"] = "true";
}

function markLoaded(image: HTMLImageElement): void {
  delete image.dataset["mediaLoading"];
  image.dataset["mediaLoaded"] = "true";
}

function attach(image: HTMLImageElement): void {
  if (image.dataset["mediaBound"] === "true") return;
  image.dataset["mediaBound"] = "true";

  // Both a cached success and a cached failure can resolve before this script
  // runs, so `complete` is settled here rather than only in a listener.
  if (image.complete) {
    if (image.naturalWidth === 0) markFailed(image);
    else markLoaded(image);
    return;
  }

  markLoading(image);
  image.addEventListener("load", () => markLoaded(image), { once: true });
  image.addEventListener("error", () => markFailed(image), { once: true });
}

function scan(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>(IMAGE)) {
    attach(image);
  }
}

export function initMediaFallbacks(): void {
  scan(document);

  // Content rendered later — search results, an embed's poster after a click —
  // is covered by observing for new frames rather than by re-scanning on a
  // timer.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) scan(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
