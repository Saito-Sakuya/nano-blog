import { describe, expect, it, vi } from "vitest";

/**
 * `robots.txt`, which is the only thing standing between a preview deployment
 * and a second copy of every article on the web.
 *
 * Both branches are asserted by running the route itself under both
 * environments: `isIndexable()` reads `SITE_ENV` once, at module load, so the
 * production text is otherwise only reachable by rebuilding with a different
 * environment value.
 */

/**
 * The route module, loaded through a variable.
 *
 * A static import would put an Astro endpoint into the TypeScript program that
 * checks `scripts/` and `tests/`, and that program has no `astro:content` (a
 * virtual module only Astro's generated types describe) and pulls in Astro's
 * published declarations, which do not compile under this repository's
 * `skipLibCheck: false`. The endpoint is type-checked by `astro check`, against
 * the real framework types; the shape below is the whole of what this test
 * uses, and using it is what checks it.
 */
const ROUTE_MODULE = "../../src/pages/robots.txt";

interface RouteModule {
  readonly GET: () => Response | Promise<Response>;
  readonly robotsTxt: (indexable: boolean) => string;
}

async function loadRoute(): Promise<RouteModule> {
  return (await import(/* @vite-ignore */ ROUTE_MODULE)) as RouteModule;
}

/** Run the route and read what it would serve, under the current environment. */
async function fetchRobots(): Promise<{
  readonly body: string;
  readonly contentType: string | null;
}> {
  const route = await loadRoute();
  const response = await route.GET();
  return {
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

describe("robotsTxt — production", () => {
  it("allows crawling and advertises the sitemap", async () => {
    const route = await loadRoute();
    const body = route.robotsTxt(true);

    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    expect(body).toMatch(/^Sitemap: https:\/\/\S+\/sitemap-index\.xml$/mu);
  });

  it("keeps crawlers out of the API", async () => {
    // The comment and view endpoints answer with JSON, and the comment endpoint
    // is POST-only: a crawler that follows one has found a dead end at best.
    const route = await loadRoute();

    expect(route.robotsTxt(true)).toContain("Disallow: /api/");
  });

  it("keeps crawlers out of the closed-comments manifest", async () => {
    // It is served from the site root and read by the endpoint. Public in the
    // sense that it is reachable, and still nothing a search result should point
    // at.
    const route = await loadRoute();

    expect(route.robotsTxt(true)).toContain("Disallow: /comments-closed.json");
  });

  it("orders the rules so the allow is read first", async () => {
    const route = await loadRoute();
    const body = route.robotsTxt(true);

    expect(body.indexOf("Allow: /")).toBeLessThan(
      body.indexOf("Disallow: /api/"),
    );
  });
});

describe("robotsTxt — anything that is not production", () => {
  it("forbids crawling outright and points at no sitemap", async () => {
    const route = await loadRoute();
    const body = route.robotsTxt(false);

    expect(body).toBe("User-agent: *\nDisallow: /\n");
    // A preview must never point a crawler at URLs that belong to the live
    // domain.
    expect(body).not.toContain("Sitemap:");
  });
});

describe("the robots.txt route", () => {
  it("serves the forbidding text for this build's environment", async () => {
    // The unit environment is `SITE_ENV=local`, pinned by `vitest.config.ts`.
    const { body, contentType } = await fetchRobots();

    expect(contentType).toContain("text/plain");
    expect(body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("allows crawling, and closes the API, in a production build", async () => {
    vi.stubEnv("SITE_ENV", "production");
    // `SITE_ENV` is read once, at module load, so the module has to be loaded
    // again under the new environment for this to mean anything.
    vi.resetModules();
    const { body } = await fetchRobots();
    vi.unstubAllEnvs();

    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /comments-closed.json");
    expect(body).toContain(
      "Sitemap: https://blog.example.invalid/sitemap-index.xml",
    );
  });
});
