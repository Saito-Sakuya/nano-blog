/**
 * Browsers report requests cancelled by a page transition as failures even
 * though the destination page and its resources load normally. Only these
 * known cancellation messages, from origins served by this E2E run, are
 * excluded from the no-network-errors assertion.
 */
const BROWSER_CANCELLATIONS = [
  "NS_BINDING_ABORTED",
  "Load request cancelled",
  "net::ERR_ABORTED",
] as const;

export function isBrowserCancelledRequest(
  requestUrl: string,
  errorText: string,
  allowedOrigins: readonly string[],
): boolean {
  if (!BROWSER_CANCELLATIONS.some((phrase) => errorText.includes(phrase))) {
    return false;
  }

  try {
    const requestOrigin = new URL(requestUrl).origin;
    return allowedOrigins.some(
      (origin) => new URL(origin).origin === requestOrigin,
    );
  } catch {
    return false;
  }
}
