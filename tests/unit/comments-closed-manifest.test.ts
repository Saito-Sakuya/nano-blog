import { describe, expect, it, vi } from "vitest";

/**
 * The closed-comments manifest, as the build writes it.
 *
 * Two things about this file are public commitments rather than implementation
 * details. It is served to anyone who asks, so an unpublished article's id must
 * not be in it — a draft's id is the path its page will eventually live at. And
 * because the build is static, a response header set by the route never reaches
 * the deployed file, so the route must not pretend to set one.
 *
 * `astro:content` only exists inside an Astro build, so the collection is
 * supplied here. Everything else in the route — the visibility rule, the clock,
 * the manifest shape — is the real code.
 */

const getCollection = vi.fn();

vi.mock("astro:content", () => ({
  getCollection: (name: string) => getCollection(name) as unknown,
}));

/**
 * The route, loaded through a variable.
 *
 * A static import of an Astro route would make the TypeScript program that
 * checks `scripts/` and `tests/` resolve `astro:content`, which is a virtual
 * module only Astro's own generated types can describe; the route itself is
 * type-checked by `astro check`, against the real collection types. The shape
 * below is the whole of what this test uses.
 */
const ROUTE_MODULE = "../../src/pages/comments-closed.json";

interface RouteModule {
  readonly GET: () => Promise<Response>;
}

async function loadRoute(): Promise<RouteModule> {
  return (await import(/* @vite-ignore */ ROUTE_MODULE)) as RouteModule;
}

interface Entry {
  readonly id: string;
  readonly data: {
    readonly draft: boolean;
    readonly publishedAt: string;
    readonly comments: boolean;
  };
}

const PUBLIC_CLOSED: Entry = {
  id: "notes/comments-off",
  data: {
    draft: false,
    publishedAt: "2026-05-22T09:00:00+08:00",
    comments: false,
  },
};
const PUBLIC_OPEN: Entry = {
  id: "notes/first-note",
  data: {
    draft: false,
    publishedAt: "2026-05-01T09:00:00+08:00",
    comments: true,
  },
};
const DRAFT_CLOSED: Entry = {
  id: "internal/unannounced-draft",
  data: {
    draft: true,
    publishedAt: "2026-05-01T09:00:00+08:00",
    comments: false,
  },
};
const FUTURE_CLOSED: Entry = {
  id: "internal/scheduled-embargo",
  data: {
    draft: false,
    publishedAt: "2099-12-31T23:59:00+08:00",
    comments: false,
  },
};

async function getManifest(entries: readonly Entry[]): Promise<Response> {
  getCollection.mockResolvedValue(entries);
  const route = await loadRoute();
  return route.GET();
}

describe("comments-closed.json", () => {
  it("lists a public article whose comments are off", async () => {
    const response = await getManifest([PUBLIC_CLOSED, PUBLIC_OPEN]);
    const body = (await response.json()) as { closed: string[] };

    expect(body.closed).toEqual(["notes/comments-off"]);
    expect(getCollection).toHaveBeenCalledWith("posts");
  });

  it("keeps a draft's id out of the manifest", async () => {
    const response = await getManifest([PUBLIC_CLOSED, DRAFT_CLOSED]);
    const body = (await response.json()) as { closed: string[] };

    expect(body.closed).not.toContain(DRAFT_CLOSED.id);
    expect(body.closed).toEqual(["notes/comments-off"]);
  });

  it("keeps a future-dated article's id out of the manifest", async () => {
    const response = await getManifest([PUBLIC_CLOSED, FUTURE_CLOSED]);
    const body = (await response.json()) as { closed: string[] };

    expect(body.closed).not.toContain(FUTURE_CLOSED.id);
  });

  it("names no unpublished article even when nothing is public", async () => {
    const response = await getManifest([DRAFT_CLOSED, FUTURE_CLOSED]);
    const body = (await response.json()) as { closed: string[] };

    expect(body.closed).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("internal/");
  });

  it("keeps an open article out of the manifest", async () => {
    const response = await getManifest([PUBLIC_OPEN]);
    const body = (await response.json()) as { closed: string[] };

    expect(body.closed).toEqual([]);
  });

  it("declares no cache control, because a static build cannot carry one", async () => {
    // The header would be written to the response object and then dropped: in
    // `output: "static"` only the body reaches `dist/`. A route that appears to
    // set a cache policy is worse than one that does not, because the next
    // reader believes it.
    const response = await getManifest([PUBLIC_CLOSED]);

    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
