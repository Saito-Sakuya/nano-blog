import { describe, expect, it } from "vitest";

import {
  FUNCTION_CSP,
  withFunctionHeaders,
} from "../../functions/lib/security-headers.js";
import type { PagesMiddlewareContext } from "../../functions/lib/context.js";

/**
 * The Functions layer's own response headers.
 *
 * Scoped to `/api/*` and `/avatar/*` by where its two middlewares live, so the
 * only thing left to get wrong here is what it does to a response that already
 * carries a policy — and that is exactly what these assert.
 */

function context(response: Response, method = "GET"): PagesMiddlewareContext {
  return {
    request: new Request("https://blog.example/api/views/x", { method }),
    env: {},
    params: {},
    next: () => Promise.resolve(response),
  };
}

describe("withFunctionHeaders", () => {
  it("adds the common headers and its own policy", async () => {
    const result = await withFunctionHeaders(
      context(
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ),
    );

    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("x-frame-options")).toBe("DENY");
    expect(result.headers.get("content-security-policy")).toBe(FUNCTION_CSP);
    expect(result.status).toBe(200);
  });

  it("keeps a policy the route already set", async () => {
    /*
     * The avatar route sets its own `default-src 'none'` on the generated mark.
     * Overwriting it would be harmless here and wrong in principle: which layer
     * decides the policy should not depend on evaluation order.
     */
    const own = "default-src 'none'; style-src 'unsafe-inline'";
    const result = await withFunctionHeaders(
      context(
        new Response("<svg/>", {
          headers: { "content-security-policy": own },
        }),
      ),
    );

    expect(result.headers.get("content-security-policy")).toBe(own);
  });

  it("does not store a POST answer, and leaves a GET's own cache policy alone", async () => {
    const posted = await withFunctionHeaders(
      context(new Response("{}", { status: 202 }), "POST"),
    );
    expect(posted.headers.get("cache-control")).toBe("no-store");

    const own = "public, max-age=60";
    const fetched = await withFunctionHeaders(
      context(new Response("{}", { headers: { "cache-control": own } })),
    );
    expect(fetched.headers.get("cache-control")).toBe(own);
  });

  it("carries the status and body through unchanged", async () => {
    const result = await withFunctionHeaders(
      context(new Response("nope", { status: 403 })),
    );
    expect(result.status).toBe(403);
    expect(await result.text()).toBe("nope");
  });
});
