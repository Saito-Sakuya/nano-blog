import { describe, expect, it } from "vitest";

import {
  RATE_LIMITS,
  callerKey,
  checkRateLimit,
  secondsIntoWindow,
  windowKey,
} from "../../src/lib/comments/rate-limit";

/**
 * The rate limiter.
 *
 * These tests exist because the limiter is deliberately switched *off* in the
 * end-to-end harness: every browser project in a run reaches the API from the
 * same loopback address, so six projects submitting comments would exhaust a
 * three-per-ten-minutes budget by the third, and the failures would look like a
 * broken endpoint rather than an exhausted budget. A rule about counts belongs
 * here, where the count can be set directly, not in six parallel browser
 * projects.
 *
 * So these are the only tests that check the limiter at all, and the switch that
 * bypasses it is itself asserted below — a bypass nobody tests is a bypass that
 * eventually leaks into production behaviour.
 */

describe("checkRateLimit — the arithmetic", () => {
  const rule = { limit: 3, windowSeconds: 600 };

  it("allows the first action and reports what is left", () => {
    const decision = checkRateLimit(rule, 0, 0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
  });

  it("allows up to the limit and refuses the one past it", () => {
    for (const used of [0, 1, 2]) {
      expect(checkRateLimit(rule, used, 10).allowed, `used ${used}`).toBe(true);
    }
    expect(checkRateLimit(rule, 3, 10).allowed).toBe(false);
    expect(checkRateLimit(rule, 99, 10).allowed).toBe(false);
  });

  it("reports the seconds until the window ends, and never zero", () => {
    expect(checkRateLimit(rule, 3, 0).retryAfterSeconds).toBe(600);
    expect(checkRateLimit(rule, 3, 599).retryAfterSeconds).toBe(1);
    // At the boundary the window is over; reporting 0 would mean "retry now"
    // while the caller is still being refused.
    expect(checkRateLimit(rule, 3, 600).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("treats a negative or unparsable count as zero rather than as unlimited", () => {
    // A storage value that cannot be read must not become a licence to post.
    expect(checkRateLimit(rule, -5, 0).allowed).toBe(true);
    expect(checkRateLimit(rule, Number.NaN, 0).allowed).toBe(true);
    expect(checkRateLimit(rule, Number.NaN, 0).remaining).toBe(2);
  });

  it("clamps an elapsed time outside the window", () => {
    expect(checkRateLimit(rule, 0, -100).retryAfterSeconds).toBe(600);
    expect(checkRateLimit(rule, 0, 10_000).retryAfterSeconds).toBe(1);
  });

  it("applies each production rule with its own limit", () => {
    expect(
      checkRateLimit(RATE_LIMITS.comment, RATE_LIMITS.comment.limit, 0).allowed,
    ).toBe(false);
    expect(
      checkRateLimit(RATE_LIMITS.view, RATE_LIMITS.view.limit, 0).allowed,
    ).toBe(false);
    // The daily comment budget is larger than the per-minute one, which is the
    // point of having both.
    expect(RATE_LIMITS.commentDaily.limit).toBeGreaterThan(
      RATE_LIMITS.comment.limit,
    );
  });
});

describe("windowKey and secondsIntoWindow", () => {
  const NOW = new Date("2026-09-17T12:00:00.000Z");

  it("gives one key per window, stable inside it", () => {
    const a = windowKey("comment", NOW);
    const b = windowKey("comment", new Date(NOW.getTime() + 60_000));
    expect(a).toBe(b);
  });

  it("changes the key when the window rolls over", () => {
    const a = windowKey("comment", NOW);
    const b = windowKey("comment", new Date(NOW.getTime() + 601_000));
    expect(a).not.toBe(b);
  });

  it("reports how far into the window a moment is", () => {
    const key = windowKey("comment", NOW);
    const atStart = secondsIntoWindow("comment", key, NOW);
    const later = secondsIntoWindow(
      "comment",
      key,
      new Date(NOW.getTime() + 120_000),
    );
    expect(later - atStart).toBe(120);
  });

  it("keeps the two windows independent", () => {
    // A caller out of per-minute budget is not out of daily budget.
    const minute = windowKey("comment", NOW);
    const day = windowKey("commentDaily", NOW);
    expect(minute).not.toBe(day);
  });

  it("never reports a negative position inside the window", () => {
    const key = windowKey("comment", NOW);
    const before = secondsIntoWindow(
      "comment",
      key,
      new Date(NOW.getTime() - 600_000),
    );
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe("callerKey", () => {
  const secret = "a".repeat(40);

  it("is stable for the same address and secret", async () => {
    const a = await callerKey(secret, "203.0.113.7");
    const b = await callerKey(secret, "203.0.113.7");
    expect(a).toBe(b);
  });

  it("separates two addresses", async () => {
    const a = await callerKey(secret, "203.0.113.7");
    const b = await callerKey(secret, "203.0.113.8");
    expect(a).not.toBe(b);
  });

  it("separates the same address under a different secret", async () => {
    /*
     * This is the property that makes the stored value useless to anyone who
     * obtains the database: without the secret, an address cannot be matched
     * against the hash by enumeration.
     */
    const a = await callerKey(secret, "203.0.113.7");
    const b = await callerKey("b".repeat(40), "203.0.113.7");
    expect(a).not.toBe(b);
  });

  it("does not contain the address", async () => {
    const key = await callerKey(secret, "203.0.113.7");
    expect(key).not.toContain("203.0.113.7");
    expect(key).not.toContain("203");
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is a 64-character hex digest for any input", async () => {
    for (const address of ["", "::1", "2001:db8::1", "unknown"]) {
      expect(await callerKey(secret, address), address).toMatch(
        /^[0-9a-f]{64}$/u,
      );
    }
  });
});
