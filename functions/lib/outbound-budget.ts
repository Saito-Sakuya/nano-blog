/**
 * A budget on outbound requests, per isolate.
 *
 * ## Why this exists
 *
 * `/avatar/<hash>` fetches from Gravatar for any well-formed digest. The digest
 * is the only input, so an attacker can mint a fresh one per request and every
 * request is a cache miss followed by a subrequest — a cheap way to make this
 * deployment perform expensive work on someone else's behalf and, on a metered
 * plan, to spend the operator's quota. Validating the digest (which the endpoint
 * does) does not help: `0`×32 and `f`×32 are both valid and both unknown to
 * Gravatar.
 *
 * A per-caller rate limit would be the usual answer, but the avatar endpoint
 * deliberately has no store: an avatar is decoration, and making every image
 * request depend on a database would let a storage failure break the appearance
 * of every page with a comment. A budget on the shared resource — the outbound
 * request itself — needs no caller identity and no storage.
 *
 * ## What it does and does not promise
 *
 * The counter lives in one isolate's memory, so it bounds the requests *this
 * isolate* makes, not the deployment's total: Cloudflare runs many isolates and
 * the real ceiling is the budget multiplied by however many are warm. That is
 * weaker than a global limit and is stated here rather than implied away. It is
 * still the property that matters for the failure it prevents, because
 * amplification is only useful to an attacker at volume and any single isolate
 * now stops after its budget rather than serving an unbounded number.
 *
 * When the budget is exhausted the endpoint serves the locally generated mark
 * instead of fetching. A reader sees a slightly different avatar; nobody sees an
 * error, and the work is bounded.
 */

export interface OutboundBudgetOptions {
  /** Outbound requests allowed inside one window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /**
   * Reads the clock. Injected so the budget's behaviour over time can be tested
   * without waiting for it.
   */
  readonly now?: () => number;
}

/**
 * A fixed-window counter.
 *
 * A fixed window rather than a rolling one for the same reason the comment
 * limiter uses one: it costs a single number, and the boundary effect it accepts
 * (a burst either side of a boundary) is irrelevant when the purpose is to bound
 * sustained work.
 */
export class OutboundBudget {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  #windowStart = 0;
  #used = 0;

  constructor(options: OutboundBudgetOptions) {
    if (!Number.isFinite(options.limit) || options.limit < 1) {
      throw new Error("An outbound budget needs a positive limit.");
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new Error("An outbound budget needs a positive window.");
    }
    this.#limit = Math.floor(options.limit);
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? ((): number => Date.now());
  }

  /**
   * Take one unit, if any is left. True means the caller may proceed.
   *
   * Both clock faults keep counting rather than refilling:
   *
   *   - a reading *before* the current window neither resets nor refills, so a
   *     backwards jump cannot open a new budget early;
   *   - a non-finite reading cannot open a window at all, so an unreadable clock
   *     is not an unlimited budget.
   *
   * The first version of this method reset the window on both, which the test
   * for the non-finite case caught: two calls with `Date.now()` returning `NaN`
   * produced a budget that never ran out.
   */
  take(): boolean {
    const current = this.#now();

    if (
      Number.isFinite(current) &&
      current >= this.#windowStart + this.#windowMs
    ) {
      this.#windowStart = current;
      this.#used = 0;
    }

    if (this.#used >= this.#limit) return false;
    this.#used += 1;
    return true;
  }

  /** Units left in the current window, for a diagnostic header or a test. */
  remaining(): number {
    return Math.max(0, this.#limit - this.#used);
  }
}
