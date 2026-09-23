import { expect, test, type Page } from "@playwright/test";

/**
 * The browser-spec base, with the unreachable media host neutralised.
 *
 * Every cover, figure and poster is normally served from
 * `https://media.example.invalid`, a Cloudflare resource this repository is
 * forbidden from creating. The E2E runner instead builds an isolated copy with
 * a loopback media origin, whose preconnect and real image requests complete
 * without DNS or an external network dependency.
 *
 * Failure behaviour is deliberately opt-in. A test that needs to check the
 * fallback panel installs its own page route for the media request; making
 * every page fail every image made Firefox's document `load` event depend on
 * its failed-resource bookkeeping, rather than on the behaviour the test was
 * actually exercising.
 *
 * Import `test` and `expect` from this module rather than from
 * `@playwright/test` so the behaviour applies uniformly.
 */

type GotoOptions = NonNullable<Parameters<Page["goto"]>[1]>;

/** The public media origin the E2E runner configured at build time. */
export const MEDIA_ORIGIN = (
  process.env["E2E_MEDIA_ORIGIN"] ?? "https://media.example.invalid"
).replace(/\/+$/u, "");

/**
 * Navigate to a page once its document and synchronous module scripts are
 * ready. Individual tests assert the specific UI or network state they need;
 * waiting for every unrelated image and preconnect to settle makes those
 * assertions depend on browser-specific `load` bookkeeping.
 */
export function visit(page: Page, url: string, options: GotoOptions = {}) {
  return page.goto(url, { waitUntil: "domcontentloaded", ...options });
}

export { expect, test };
