import { withFunctionHeaders } from "../lib/security-headers.js";
import type { PagesMiddlewareContext } from "../lib/context.js";

/**
 * Security headers for `/api/*`.
 *
 * Scoped to this directory rather than declared at the root of `functions/`, so
 * it cannot reach a static document — see `functions/lib/security-headers.ts`
 * for why that distinction matters.
 */
export async function onRequest(
  context: PagesMiddlewareContext,
): Promise<Response> {
  return withFunctionHeaders(context);
}
