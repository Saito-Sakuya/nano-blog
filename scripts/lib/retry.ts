/**
 * Retry policy.
 *
 * Reads and immutable writes (`GET`, `HEAD`, `LIST`, and a `PUT` that creates a
 * key which must not already exist) are retried on 429 and 5xx with exponential
 * backoff and jitter: they are idempotent, so repeating them cannot change the
 * outcome.
 *
 * Two things are deliberately *not* retried here:
 *
 * - The conditional write of `active.json`. Retrying it with a stale ETag would
 *   either fail forever or, worse, succeed against a state the caller never
 *   read. The caller re-reads the pointer and re-verifies instead.
 * - Deletes. A delete that appears to fail may have succeeded; repeating it
 *   blindly can remove an object that a concurrent publish just re-created.
 *
 * `attemptOnce` exists so those call sites state that intent in code.
 */

export interface RetryPolicy {
  /** Attempts *after* the first one. Three retries means up to four attempts. */
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the computed delay that is randomised, 0–1. */
  readonly jitterRatio: number;
}

export const MAX_RETRIES = 3;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: MAX_RETRIES,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitterRatio: 0.25,
};

export interface RetryInfo {
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryDependencies {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: RetryInfo) => void;
}

export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(
      `Gave up after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Exponential backoff with full-jitter-bounded noise.
 *
 * `baseDelayMs * 2^(attempt-1)`, capped, plus up to `jitterRatio` of the delay.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const jitter = capped * policy.jitterRatio * random();
  return Math.round(capped + jitter);
}

/** 429 and 5xx are worth another attempt; everything else is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

const RETRYABLE_NAMES = new Set([
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
  "RequestTimeout",
  "RequestTimeoutException",
  "RequestTimeTooSkewed",
  "ThrottlingException",
  "Throttling",
  "TooManyRequestsException",
  "ProvisionedThroughputExceededException",
  "TimeoutError",
  "NetworkingError",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "FetchError",
  "ServerError",
]);

const NON_RETRYABLE_NAMES = new Set([
  "PreconditionFailed",
  "ConditionalRequestConflict",
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "NoSuchKey",
  "NoSuchBucket",
  "NotFound",
  "ValidationException",
  "InvalidArgument",
  "MalformedXML",
  "EntityTooLarge",
  "EntityTooSmall",
  "BadDigest",
  "CredentialsProviderError",
  "AbortError",
]);

function numericProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.length > 0 && Number.isFinite(Number(raw)))
    return Number(raw);
  return undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : undefined;
}

/** The HTTP status an SDK or fetch error carries, when it carries one. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  return (
    numericProperty(metadata, "httpStatusCode") ??
    numericProperty(error, "status") ??
    numericProperty(error, "statusCode")
  );
}

/** True when an error is a transport or service error that may succeed later. */
export function isRetryableError(error: unknown): boolean {
  const name =
    stringProperty(error, "name") ??
    (error instanceof Error ? error.name : undefined);
  if (name !== undefined && NON_RETRYABLE_NAMES.has(name)) return false;

  const code = stringProperty(error, "code");
  if (code !== undefined && NON_RETRYABLE_NAMES.has(code)) return false;

  const status = statusOf(error);
  if (status !== undefined) return isRetryableStatus(status);

  if (name !== undefined && RETRYABLE_NAMES.has(name)) return true;
  if (code !== undefined && RETRYABLE_NAMES.has(code)) return true;

  // A bare TypeError from `fetch` is what a dropped connection looks like.
  return error instanceof TypeError;
}

export interface WithRetryOptions {
  readonly policy?: Partial<RetryPolicy>;
  readonly dependencies?: RetryDependencies;
  readonly isRetryable?: (error: unknown) => boolean;
}

/**
 * Run `operation` until it succeeds, the policy is exhausted, or the failure is
 * one that will not improve. `operation` receives the 1-based attempt number so
 * a caller can log progress without keeping its own counter.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const sleep = options.dependencies?.sleep ?? defaultSleep;
  const random = options.dependencies?.random ?? Math.random;
  const isRetryable = options.isRetryable ?? isRetryableError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.retries + 1; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const attemptsLeft = policy.retries + 1 - attempt;
      if (attemptsLeft <= 0 || !isRetryable(error)) break;

      const delayMs = backoffDelay(attempt, policy, random);
      options.dependencies?.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Run `operation` exactly once.
 *
 * Used for the `active.json` compare-and-swap and for deletes: on failure the
 * caller re-reads the remote state and re-verifies its plan rather than
 * repeating a request whose effect it cannot observe.
 */
export async function attemptOnce<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
