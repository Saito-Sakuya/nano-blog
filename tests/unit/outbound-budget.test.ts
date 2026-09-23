import { describe, expect, it } from "vitest";

import { OutboundBudget } from "../../functions/lib/outbound-budget.js";

/**
 * The outbound budget, with the clock injected.
 *
 * Only the properties that matter are asserted: it stops after the limit, it
 * refills when the window turns over, and a clock that jumps backwards cannot
 * hand out a second budget. The class exists because the avatar endpoint can be
 * made to fetch from a third party once per request with an attacker-chosen key,
 * so "does it stop" is a correctness question rather than a tuning one.
 */

describe("OutboundBudget", () => {
  it("allows exactly the limit inside one window", () => {
    const now = 0;
    const budget = new OutboundBudget({
      limit: 3,
      windowMs: 1000,
      now: () => now,
    });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("refills when the window turns over", () => {
    let now = 0;
    const budget = new OutboundBudget({
      limit: 1,
      windowMs: 1000,
      now: () => now,
    });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);

    now = 1000;
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("does not refill when the clock moves backwards", () => {
    // A backwards clock must not read as a new window: that would let a time
    // adjustment, or a caller who can influence one, reset the budget early.
    let now = 5000;
    const budget = new OutboundBudget({
      limit: 1,
      windowMs: 1000,
      now: () => now,
    });

    expect(budget.take()).toBe(true);

    now = 100;
    expect(budget.take()).toBe(false);

    // Returning to a time still inside the window that began at 5000 is still
    // the same window.
    now = 5200;
    expect(budget.take()).toBe(false);

    // Once that window has elapsed, the next unit is available.
    now = 6000;
    expect(budget.take()).toBe(true);
  });

  it("keeps counting when the clock cannot be read, rather than becoming unlimited", () => {
    let now = Number.NaN;
    const budget = new OutboundBudget({
      limit: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);

    // A readable clock restores the normal behaviour.
    now = 10;
    expect(budget.take()).toBe(false);
    now = 2000;
    expect(budget.take()).toBe(true);
  });

  it("refuses a configuration it cannot enforce", () => {
    expect(() => new OutboundBudget({ limit: 0, windowMs: 1000 })).toThrow(
      /positive limit/u,
    );
    expect(() => new OutboundBudget({ limit: 1, windowMs: 0 })).toThrow(
      /positive window/u,
    );
    expect(
      () => new OutboundBudget({ limit: Number.NaN, windowMs: 1000 }),
    ).toThrow(/positive limit/u);
  });
});
