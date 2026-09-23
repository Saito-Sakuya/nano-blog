import { describe, expect, it } from "vitest";

import { isPublicAt } from "../../src/lib/content/visibility";

const NOW = new Date("2026-09-15T00:00:00.000Z");

describe("isPublicAt", () => {
  it("publishes a past-dated, non-draft entry", () => {
    expect(
      isPublicAt(
        { draft: false, publishedAt: "2026-09-14T00:00:00+08:00" },
        NOW,
      ),
    ).toBe(true);
  });

  it("never publishes a draft", () => {
    expect(
      isPublicAt(
        { draft: true, publishedAt: "2020-01-01T00:00:00+08:00" },
        NOW,
      ),
    ).toBe(false);
  });

  it("never publishes a future-dated entry", () => {
    expect(
      isPublicAt(
        { draft: false, publishedAt: "2026-09-16T00:00:00+08:00" },
        NOW,
      ),
    ).toBe(false);
  });

  it("publishes an entry dated exactly at the build instant", () => {
    expect(
      isPublicAt({ draft: false, publishedAt: NOW.toISOString() }, NOW),
    ).toBe(true);
  });

  it("compares instants across time zones, not local wall-clock text", () => {
    // 2026-09-15T06:00+08:00 is 2026-09-14T22:00Z — in the past.
    expect(
      isPublicAt(
        { draft: false, publishedAt: "2026-09-15T06:00:00+08:00" },
        NOW,
      ),
    ).toBe(true);
    // 2026-09-15T09:00+08:00 is 2026-09-15T01:00Z — still in the future.
    expect(
      isPublicAt(
        { draft: false, publishedAt: "2026-09-15T09:00:00+08:00" },
        NOW,
      ),
    ).toBe(false);
  });

  it("treats an unparseable date as not public rather than throwing", () => {
    expect(isPublicAt({ draft: false, publishedAt: "not a date" }, NOW)).toBe(
      false,
    );
  });

  it("publishes an entry with no publish date, such as a page", () => {
    expect(isPublicAt({ draft: false }, NOW)).toBe(true);
  });

  it("keeps a draft hidden regardless of its date", () => {
    expect(isPublicAt({ draft: true }, NOW)).toBe(false);
  });
});
