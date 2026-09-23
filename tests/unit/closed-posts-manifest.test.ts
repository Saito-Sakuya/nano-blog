import { describe, expect, it } from "vitest";

import { createClosedPostsLoader } from "../../functions/lib/closed-posts-manifest.js";

/**
 * The closed-articles loader, shared by the deployed route and the test harness.
 *
 * It is tested directly because it is the seam that failed: the harness once
 * decided the flag itself, so the browser test for "a closed article refuses
 * comments" passed while the deployed route never passed the flag at all. The
 * factory is what both now build from, so its caching and its failure behaviour
 * are the behaviour of both.
 */

describe("createClosedPostsLoader", () => {
  it("parses the manifest shape the build writes", async () => {
    const load = createClosedPostsLoader(async () => ({
      schemaVersion: 1,
      closed: ["notes/comments-off", "another/closed-post"],
    }));

    const closed = await load();
    expect(closed.has("notes/comments-off")).toBe(true);
    expect(closed.has("notes/other")).toBe(false);
  });

  it("reads once, however many callers ask", async () => {
    let reads = 0;
    const load = createClosedPostsLoader(async () => {
      reads += 1;
      return { schemaVersion: 1, closed: ["a"] };
    });

    await Promise.all([load(), load(), load()]);
    await load();

    expect(reads).toBe(1);
  });

  it("treats a missing or malformed manifest as 'nothing is closed'", async () => {
    // The documented reading, and the one the markup assumes: a deployment that
    // lost the file accepts comments rather than silently rejecting every one.
    const load = createClosedPostsLoader(async () => {
      throw new Error("ENOENT");
    });
    expect((await load()).size).toBe(0);

    const garbage = createClosedPostsLoader(async () => "not an object");
    expect((await garbage()).size).toBe(0);
  });

  it("retries after a failure rather than remembering it", async () => {
    // A transient network error must not close the manifest for the life of the
    // isolate, which is how long a cached result lives.
    let attempt = 0;
    const load = createClosedPostsLoader(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network");
      return { schemaVersion: 1, closed: ["notes/comments-off"] };
    });

    expect((await load()).size).toBe(0);
    expect((await load()).has("notes/comments-off")).toBe(true);
    expect(attempt).toBe(2);
  });
});
