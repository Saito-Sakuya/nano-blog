import { describe, expect, it } from "vitest";

import {
  parseRedirects,
  validateRedirects,
  type RedirectRule,
} from "../../scripts/content/redirects";

const KNOWN = new Set([
  "/",
  "/posts/",
  "/archive/",
  "/about/",
  "/posts/new/path/",
  "/posts/other/",
  "/tags/",
]);

const STATIC = ["/rss.xml", "/robots.txt", "/404.html", "/favicon.svg"];

function rules(text: string): RedirectRule[] {
  const parsed = parseRedirects(text);
  if (!parsed.ok) throw new Error("expected a parseable table");
  return [...parsed.rules];
}

function codes(text: string, known: ReadonlySet<string> = KNOWN): string[] {
  const parsed = parseRedirects(text);
  if (!parsed.ok) return parsed.issues.map((issue) => issue.code);
  return validateRedirects(parsed.rules, {
    knownUrls: known,
    staticFiles: STATIC,
  }).map((issue) => issue.code);
}

describe("parseRedirects", () => {
  it("reads rules, comments and blank lines", () => {
    const parsed = parseRedirects(
      [
        "# a comment",
        "",
        "/posts/old/path/  /posts/new/path/  301",
        "   ",
        "/old-about/  /about/",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]).toMatchObject({
      from: "/posts/old/path/",
      to: "/posts/new/path/",
      status: 301,
      line: 3,
    });
    // No status field defaults to a permanent redirect.
    expect(parsed.rules[1]).toMatchObject({ status: 301, line: 5 });
  });

  it("accepts a rule on a line that also carries a trailing comment", () => {
    const parsed = parseRedirects("/old/  /about/  302 # moved in 2026");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules[0]).toMatchObject({ status: 302 });
  });

  it("rejects a line with too few fields", () => {
    // One issue per bad line: a malformed line produces exactly one report.
    expect(codes("/only-one-field/")).toEqual(["redirect-syntax"]);
  });

  it("rejects a line with too many fields", () => {
    expect(codes("/a/  /about/  301  extra")).toEqual(["redirect-syntax"]);
  });

  it("rejects a status code Cloudflare would not accept", () => {
    expect(codes("/old/  /about/  200")).toEqual(["redirect-status"]);
    expect(codes("/old/  /about/  999")).toEqual(["redirect-status"]);
  });

  it("rejects a relative source or destination", () => {
    expect(codes("old/  /about/")).toEqual(["redirect-syntax"]);
    expect(codes("/old/  about/")).toEqual(["redirect-syntax"]);
  });

  it("rejects wildcards, which would be a catch-all", () => {
    // Sending unknown old URLs to one destination is forbidden.
    expect(codes("/posts/*  /posts/")).toEqual(["redirect-catch-all"]);
    expect(codes("/posts/:slug  /posts/")).toEqual(["redirect-catch-all"]);
  });

  it("accepts an empty table", () => {
    const parsed = parseRedirects("# nothing yet\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rules).toEqual([]);
  });
});

describe("validateRedirects", () => {
  it("accepts a rule that points at a page the site serves", () => {
    expect(codes("/posts/old/path/  /posts/new/path/")).toEqual([]);
  });

  it("accepts a destination that is a reserved route", () => {
    expect(codes("/somewhere/  /about/")).toEqual([]);
  });

  it("accepts a destination that is a static file", () => {
    expect(codes("/feed/  /rss.xml")).toEqual([]);
  });

  it("reports a destination the site will not serve", () => {
    expect(codes("/old/  /nowhere/")).toEqual(["redirect-target"]);
  });

  it("reports a self-redirect", () => {
    expect(codes("/loop/  /loop/", new Set(["/loop/"]))).toEqual([
      "redirect-loop",
    ]);
  });

  it("reports a two-hop chain and names the line to point at", () => {
    const text = ["/a/  /b/", "/b/  /posts/new/path/"].join("\n");
    const parsed = parseRedirects(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const issues = validateRedirects(parsed.rules, {
      knownUrls: new Set(["/a/", "/b/", ...KNOWN]),
      staticFiles: STATIC,
    });
    expect(issues.map((issue) => issue.code)).toEqual(["redirect-chain"]);
    expect(issues[0]?.message).toContain("/posts/new/path/");
  });

  it("reports a multi-rule cycle once, not once per rule", () => {
    const text = ["/a/  /b/", "/b/  /c/", "/c/  /a/"].join("\n");
    const parsed = parseRedirects(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const issues = validateRedirects(parsed.rules, {
      knownUrls: new Set(["/a/", "/b/", "/c/"]),
      staticFiles: STATIC,
    });
    const loops = issues.filter((issue) => issue.code === "redirect-loop");
    expect(loops).toHaveLength(1);
    expect(loops[0]?.message).toContain("/a/ → /b/ → /c/ → /a/");
  });

  it("reports one source claimed twice", () => {
    const codes = validateRedirects(rules("/a/  /about/\n/a/  /posts/"), {
      knownUrls: KNOWN,
      staticFiles: STATIC,
    }).map((issue) => issue.code);
    expect(codes).toEqual(["redirect-duplicate"]);
  });

  it("treats a trailing slash as insignificant when matching destinations", () => {
    // `/posts/new/path` and `/posts/new/path/` are the same page; a redirect
    // must not be reported as broken because the author left the slash off.
    expect(codes("/old/  /posts/new/path")).toEqual([]);
  });
});
