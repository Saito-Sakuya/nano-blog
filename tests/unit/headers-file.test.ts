import { describe, expect, it } from "vitest";

import {
  compilePattern,
  headersForPath,
  parseHeadersFile,
} from "../../scripts/verify/headers-file.js";
import { forPlainHttp } from "../../scripts/verify/static-server.js";

/**
 * The `_headers` reader, tested against the semantics the platform documents —
 * including the join behaviour, because that is the part most likely to surprise
 * whoever edits the file next.
 */

describe("parseHeadersFile", () => {
  it("reads patterns, assignments and comments", () => {
    const rules = parseHeadersFile(
      [
        "# a comment",
        "/*",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: no-referrer",
        "",
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
      ].join("\n"),
    );

    expect(rules).toHaveLength(2);
    expect(rules[0]?.pattern).toBe("/*");
    expect(rules[0]?.set).toEqual([
      { name: "X-Frame-Options", value: "DENY" },
      { name: "Referrer-Policy", value: "no-referrer" },
    ]);
    expect(rules[1]?.pattern).toBe("/assets/*");
  });

  it("reads a detach, which is how a broad rule is undone", () => {
    const rules = parseHeadersFile(
      [
        "/assets/katex/*",
        "  ! Cache-Control",
        "  Cache-Control: no-cache",
      ].join("\n"),
    );
    expect(rules[0]?.detach).toEqual(["cache-control"]);
    expect(rules[0]?.set).toEqual([
      { name: "Cache-Control", value: "no-cache" },
    ]);
  });

  it("refuses a header with no pattern to belong to", () => {
    expect(() => parseHeadersFile("  Cache-Control: no-store")).toThrow(
      /before any URL pattern/u,
    );
  });

  it("refuses a pattern that declares nothing", () => {
    expect(() => parseHeadersFile("/only-a-pattern\n//*")).toThrow(
      /declares no headers/u,
    );
  });

  it("refuses a placeholder it cannot implement instead of ignoring it", () => {
    expect(() =>
      parseHeadersFile(["/movies/:title", "  X-Movie: yes"].join("\n")),
    ).toThrow(/placeholder/u);
  });
});

describe("compilePattern", () => {
  it("matches a splat greedily", () => {
    const matches = compilePattern("/assets/*", "test");
    expect(matches("/assets/app.js")).toBe(true);
    expect(matches("/assets/nested/deep/app.js")).toBe(true);
    expect(matches("/other/app.js")).toBe(false);
  });

  it("distinguishes a directory URL from a file URL", () => {
    /*
     * The rule that was missing: an article is served at `/posts/x/`, whose
     * request path has no `.html`, so `/*.html` never applied to it.
     */
    const directory = compilePattern("/*/", "test");
    const file = compilePattern("/*.html", "test");
    expect(directory("/posts/x/")).toBe(true);
    expect(file("/posts/x/")).toBe(false);
    expect(file("/404.html")).toBe(true);
    expect(directory("/")).toBe(false);
  });

  it("treats dots in a pattern literally", () => {
    const matches = compilePattern("/rss.xml", "test");
    expect(matches("/rss.xml")).toBe(true);
    expect(matches("/rssaxml")).toBe(false);
  });
});

describe("headersForPath", () => {
  const rules = parseHeadersFile(
    [
      "/*",
      "  Content-Security-Policy: default-src 'self'",
      "  X-Content-Type-Options: nosniff",
      "/assets/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "/assets/katex/*",
      "  ! Cache-Control",
      "  Cache-Control: public, max-age=3600, must-revalidate",
      "/*/",
      "  Cache-Control: public, max-age=0, must-revalidate",
    ].join("\n"),
  );

  it("applies every matching rule", () => {
    expect(headersForPath(rules, "/posts/x/")).toEqual({
      "content-security-policy": "default-src 'self'",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=0, must-revalidate",
    });
  });

  it("lets a detach undo a broader rule", () => {
    // Without the detach these two would be joined into one contradictory value,
    // which is what Cloudflare does with a header set twice.
    expect(headersForPath(rules, "/assets/katex/katex.min.css")).toMatchObject({
      "cache-control": "public, max-age=3600, must-revalidate",
    });
  });

  it("keeps the immutable policy for every other asset", () => {
    expect(headersForPath(rules, "/assets/app.js")).toMatchObject({
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it("joins rather than replaces when two rules set the same header", () => {
    const joined = parseHeadersFile(
      ["/*", "  X-Test: one", "/deep/*", "  X-Test: two"].join("\n"),
    );
    expect(headersForPath(joined, "/deep/x")).toMatchObject({
      "x-test": "one, two",
    });
  });

  it("matches nothing for a path no rule names", () => {
    const only = parseHeadersFile(["/assets/*", "  X-Test: one"].join("\n"));
    expect(headersForPath(only, "/posts/x/")).toEqual({});
  });
});

/*
 * The two adjustments the local server makes to the shipped policy.
 *
 * Both are narrow on purpose: everything else has to reach the page exactly as
 * deployed, because the point of applying `_headers` locally is to see the real
 * policy. A `script-src` missing `'wasm-unsafe-eval'` once shipped and broke
 * search on every deployment while every local check passed, and that is only
 * visible if the other directives are untouched.
 */
describe("forPlainHttp", () => {
  const CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://media.example.invalid data:; media-src 'self' https://media.example.invalid; connect-src 'self'; upgrade-insecure-requests";

  const policy = (out: Record<string, string>): string =>
    out["Content-Security-Policy"] ?? "";

  it("drops upgrade-insecure-requests", () => {
    const out = policy(forPlainHttp({ "Content-Security-Policy": CSP }, []));
    expect(out).not.toContain("upgrade-insecure-requests");
  });

  it("leaves every other directive exactly as it was", () => {
    const out = policy(forPlainHttp({ "Content-Security-Policy": CSP }, []));
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "img-src 'self' https://media.example.invalid data:",
      "media-src 'self' https://media.example.invalid",
      "connect-src 'self'",
    ]) {
      expect(out).toContain(directive);
    }
  });

  it("permits a local media origin in img-src and media-src only", () => {
    const out = policy(
      forPlainHttp({ "Content-Security-Policy": CSP }, [
        "http://127.0.0.1:4351",
      ]),
    );
    expect(out).toContain(
      "img-src 'self' https://media.example.invalid data: http://127.0.0.1:4351",
    );
    expect(out).toContain(
      "media-src 'self' https://media.example.invalid http://127.0.0.1:4351",
    );
    // The origin must not leak into a directive that has nothing to do with
    // loading media; `connect-src` in particular would widen what scripts may
    // call.
    expect(out).not.toContain("connect-src 'self' http://127.0.0.1:4351");
  });

  it("does not repeat an origin the policy already names", () => {
    const out = policy(
      forPlainHttp({ "Content-Security-Policy": CSP }, [
        "https://media.example.invalid",
      ]),
    );
    expect(out.match(/https:\/\/media\.example\.invalid/gu)).toHaveLength(2);
  });

  it("passes headers that are not the policy through untouched", () => {
    const out = forPlainHttp(
      { "X-Frame-Options": "DENY", "cache-control": "no-store" },
      ["http://127.0.0.1:4351"],
    );
    expect(out).toEqual({
      "X-Frame-Options": "DENY",
      "cache-control": "no-store",
    });
  });

  it("invents no policy when the file declares none", () => {
    expect(forPlainHttp({ "X-Test": "1" }, ["http://127.0.0.1:4351"])).toEqual({
      "X-Test": "1",
    });
  });
});
