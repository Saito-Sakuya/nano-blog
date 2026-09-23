import { viewsApiPath } from "../lib/routing/urls.js";
import { SITE_LANG } from "../lib/site.js";

/**
 * The view counter.
 *
 * Reads the current count and records this visit. Both halves are best-effort in
 * the strict sense: if either fails, nothing is shown, nothing is logged to the
 * reader, and the article is entirely unaffected. A statistics feature that can
 * break reading, or that interrupts it with an error message, has its priorities
 * backwards.
 *
 * The count is rendered by script rather than by the build, because a
 * build-time number would be frozen at deploy time and would be wrong the moment
 * anyone read the page. It is also why the element starts empty and hidden: an
 * empty slot that appears once filled is better than a "0" that flashes and
 * changes.
 */

interface ViewsPayload {
  readonly views?: number;
}

export function initViews(): void {
  const target = document.querySelector<HTMLElement>("[data-views]");
  if (target === null) return;

  const postId = target.dataset["postId"] ?? "";
  if (postId.length === 0) return;

  const endpoint = viewsApiPath(postId);

  const show = (count: number): void => {
    // The site's own locale, not the reader's: the counter reads the same
    // wherever the article is opened, and the digits are grouped the way every
    // other number on the page is.
    target.textContent = `${count.toLocaleString(SITE_LANG)} 次浏览`;
    // The element is hidden until it has something true to say.
    target.hidden = false;
  };

  void (async (): Promise<void> => {
    try {
      // Record first, then read, so the reader's own visit is included in the
      // number they see. The reverse order shows them a count that excludes
      // them, which reads as a bug.
      await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json" },
        /*
         * `keepalive` is what makes the count survive the reader leaving.
         *
         * The write is deliberately not awaited before the page is usable, so a
         * reader who opens an article and immediately clicks a link in it
         * navigates while the POST is still in flight — and a normal fetch is
         * cancelled with the document, losing the visit silently. `keepalive`
         * hands the request to the browser to finish after the page is gone.
         * Nothing is sent with it: the endpoint takes no body, which keeps the
         * request far below the 64 KiB keepalive limit.
         */
        keepalive: true,
      }).catch(() => undefined);

      const response = await fetch(endpoint, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;

      const payload = (await response.json()) as ViewsPayload;
      if (typeof payload.views === "number") show(payload.views);
    } catch {
      // No count is shown. Nothing else happens, which is the whole point.
    }
  })();
}
