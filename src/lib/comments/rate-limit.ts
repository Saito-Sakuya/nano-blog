/**
 * Rate limiting, expressed as a decision rather than as a database.
 *
 * The function here answers one question — *may this caller act now?* — given a
 * count of what that caller has already done inside the current window. Reading
 * and writing the counter is the storage layer's job, which keeps this pure and
 * therefore testable, and keeps the rules in one readable place instead of
 * spread across SQL conditions.
 *
 * There is no cookie and no session anywhere in this design. A caller is
 * identified by a key derived from their address, hashed with a server secret so
 * the value stored is neither reversible nor comparable across deployments. That
 * is what allows the privacy page to keep saying the site sets no cookies while
 * still having a spam limit.
 */

/** What a limiter allows within one window. */
export interface RateLimitRule {
  /** Most actions allowed per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/**
 * Two rules, both counted from the same store under different keys.
 *
 * The per-minute rule stops a script; the per-day rule stops a patient one, and
 * is what a human typist will never notice. They are deliberately generous —
 * the moderation queue is the real filter, and a limit that blocks an honest
 * reader is worse than one that lets a spammer through to be reviewed.
 */
export const RATE_LIMITS = {
  /** A comment submission. */
  comment: { limit: 3, windowSeconds: 600 },
  /** Submissions from one address in a day, across all articles. */
  commentDaily: { limit: 20, windowSeconds: 86_400 },
  /** A view ping. Cheap, but not unlimited: a loop would still be abuse. */
  view: { limit: 60, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitKind = keyof typeof RATE_LIMITS;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Actions still available in this window after this one. */
  readonly remaining: number;
  /** Seconds until the window ends, for a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

/**
 * Decide whether an action may proceed.
 *
 * @param rule      Which limit is being applied.
 * @param used      Actions already recorded inside the window.
 * @param elapsed   Seconds since the window began. A negative or unparsable
 *                  value is treated as a fresh window rather than as unlimited,
 *                  so a clock problem cannot disable the limit.
 */
export function checkRateLimit(
  rule: RateLimitRule,
  used: number,
  elapsed: number,
): RateLimitDecision {
  const windowElapsed = Number.isFinite(elapsed)
    ? Math.max(0, Math.min(elapsed, rule.windowSeconds))
    : 0;
  const counted = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
  const retryAfterSeconds = Math.max(1, rule.windowSeconds - windowElapsed);

  if (counted >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return {
    allowed: true,
    remaining: rule.limit - counted - 1,
    retryAfterSeconds,
  };
}

/**
 * The identifier of the current window, as a stable string.
 *
 * Bucketing by integer window index rather than by a rolling window keeps the
 * storage to one row per caller per window and makes expiry a matter of deleting
 * rows older than the index. The trade is a boundary effect — a caller can make
 * a full set of requests just before a boundary and another just after — which
 * is acceptable for spam control and not acceptable for anything that needs a
 * precise rate.
 */
export function windowKey(kind: RateLimitKind, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const width = RATE_LIMITS[kind].windowSeconds;
  return String(Math.floor(seconds / width));
}

/** Seconds since the window identified by `key` began. */
export function secondsIntoWindow(
  kind: RateLimitKind,
  key: string,
  now: Date,
): number {
  const width = RATE_LIMITS[kind].windowSeconds;
  const startedAt = Number(key) * width;
  const seconds = Math.floor(now.getTime() / 1000);
  return Math.max(0, Math.min(seconds - startedAt, width));
}

/**
 * A key that identifies a caller without identifying them.
 *
 * The address is combined with a server-held secret before hashing, so the
 * stored value cannot be turned back into an address by anyone who obtains the
 * database, and the same address on two deployments produces two unrelated keys.
 * Uses HMAC-SHA-256 through the platform's own crypto, which is available in
 * workerd and in Node 24 without a dependency.
 */
export async function callerKey(
  secret: string,
  address: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(address),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
