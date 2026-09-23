import { describe, expect, it } from "vitest";

import {
  relatedPosts,
  relatedScore,
  type ScorablePost,
} from "../../src/lib/content/related";

function post(
  id: string,
  options: {
    publishedAt?: string;
    tags?: { id: string; label: string }[];
    series?: { id: string };
  } = {},
): ScorablePost {
  return {
    id,
    sourcePath: `posts/${id}.md`,
    data: {
      publishedAt: options.publishedAt ?? "2026-01-01T00:00:00+08:00",
      tags: options.tags ?? [],
      series: options.series,
    },
  };
}

describe("relatedScore", () => {
  it("awards 20 for a shared series", () => {
    const a = post("a", { series: { id: "s" } });
    const b = post("b", { series: { id: "s" } });
    expect(relatedScore(a, b)).toBe(20);
  });

  it("awards 10 per shared tag", () => {
    const a = post("a", {
      tags: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    });
    const b = post("b", { tags: [{ id: "x", label: "X" }] });
    expect(relatedScore(a, b)).toBe(10);
  });

  it("adds series and tag scores together", () => {
    const a = post("a", {
      series: { id: "s" },
      tags: [{ id: "x", label: "X" }],
    });
    const b = post("b", {
      series: { id: "s" },
      tags: [{ id: "x", label: "X" }],
    });
    expect(relatedScore(a, b)).toBe(30);
  });

  it("matches tags by id, not by label", () => {
    const a = post("a", { tags: [{ id: "x", label: "Same" }] });
    const b = post("b", { tags: [{ id: "y", label: "Same" }] });
    expect(relatedScore(a, b)).toBe(0);
  });

  it("subtracts one point per whole year apart", () => {
    const a = post("a", {
      publishedAt: "2026-01-01T00:00:00Z",
      series: { id: "s" },
    });
    const b = post("b", {
      publishedAt: "2024-01-01T00:00:00Z",
      series: { id: "s" },
    });
    // 20 for the series, minus 2 for two full years.
    expect(relatedScore(a, b)).toBe(18);
  });

  it("caps the time penalty at 5", () => {
    const a = post("a", {
      publishedAt: "2026-01-01T00:00:00Z",
      tags: [{ id: "x", label: "X" }],
    });
    const b = post("b", {
      publishedAt: "1990-01-01T00:00:00Z",
      tags: [{ id: "x", label: "X" }],
    });
    expect(relatedScore(a, b)).toBe(5);
  });

  it("returns a non-positive score when nothing relates two articles", () => {
    const a = post("a", { publishedAt: "2026-01-01T00:00:00Z" });
    const b = post("b", { publishedAt: "2020-01-01T00:00:00Z" });
    expect(relatedScore(a, b)).toBeLessThanOrEqual(0);
  });
});

describe("relatedPosts", () => {
  const current = post("current", {
    publishedAt: "2026-06-01T00:00:00Z",
    series: { id: "s" },
    tags: [{ id: "x", label: "X" }],
  });

  it("excludes the current article", () => {
    const result = relatedPosts(current, [
      current,
      post("other", { series: { id: "s" } }),
    ]);
    expect(result.map((entry) => entry.id)).not.toContain("current");
  });

  it("drops candidates that score zero", () => {
    const unrelated = post("unrelated", {
      publishedAt: "1990-01-01T00:00:00Z",
    });
    expect(relatedPosts(current, [current, unrelated])).toHaveLength(0);
  });

  it("returns at most three by default", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      post(`p${index}`, { tags: [{ id: "x", label: "X" }] }),
    );
    expect(relatedPosts(current, candidates)).toHaveLength(3);
  });

  it("orders by score, then by recency", () => {
    const strong = post("strong", {
      series: { id: "s" },
      publishedAt: "2026-01-01T00:00:00Z",
    });
    const newer = post("newer", {
      tags: [{ id: "x", label: "X" }],
      publishedAt: "2026-05-01T00:00:00Z",
    });
    const older = post("older", {
      tags: [{ id: "x", label: "X" }],
      publishedAt: "2026-02-01T00:00:00Z",
    });

    const result = relatedPosts(current, [older, newer, strong]);
    expect(result.map((entry) => entry.id)).toEqual([
      "strong",
      "newer",
      "older",
    ]);
  });

  it("breaks a full tie by path so the order is stable", () => {
    const a = post("a", { tags: [{ id: "x", label: "X" }] });
    const b = post("b", { tags: [{ id: "x", label: "X" }] });
    expect(relatedPosts(current, [b, a]).map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
    expect(relatedPosts(current, [a, b]).map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("respects an explicit limit", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      post(`p${index}`, { tags: [{ id: "x", label: "X" }] }),
    );
    expect(relatedPosts(current, candidates, 1)).toHaveLength(1);
  });
});
