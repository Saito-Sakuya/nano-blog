import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../scripts/lib/concurrency";

/**
 * The two ways `mapWithConcurrency` used to lose a failure: a limit that is
 * `NaN` silently started no workers, and a worker that threw `undefined` was
 * neither rethrown nor seen.
 */

describe("mapWithConcurrency", () => {
  it("returns an empty array for no items, whatever the limit", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("keeps the input order in the results", async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item / 10));
      return item;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("never runs more workers at once than the limit allows", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("treats a limit below one as one worker", async () => {
    const seen: number[] = [];
    const result = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      seen.push(item);
      return item * 2;
    });
    expect(result).toEqual([2, 4, 6]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("refuses a NaN limit instead of returning an empty result", async () => {
    let called = false;
    await expect(
      mapWithConcurrency([1, 2], Number.NaN, async () => {
        called = true;
        return 1;
      }),
    ).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });

  it("rethrows the first failure and stops starting new work", async () => {
    const started: number[] = [];
    const failure = new Error("boom");

    await expect(
      mapWithConcurrency([1, 2, 3, 4], 1, async (item) => {
        started.push(item);
        if (item === 2) throw failure;
        return item;
      }),
    ).rejects.toBe(failure);

    expect(started).toEqual([1, 2]);
  });

  it("propagates a worker that throws undefined as a failure", async () => {
    // Rejecting with `undefined` is still a rejection: the old code compared
    // `failure !== undefined` and returned a result array with a hole in it.
    let caught: unknown = "the promise resolved";
    try {
      await mapWithConcurrency([1, 2], 2, async () => {
        throw undefined;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
  });
});
