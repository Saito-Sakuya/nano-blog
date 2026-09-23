import type { FetchLike } from "../lib/deps.js";
import { RemoteError } from "../lib/errors.js";
import type { RetryDependencies } from "../lib/retry.js";

/**
 * The Cloudflare Pages Deploy Hook.
 *
 * The hook URL is a password: it is read from the environment, used, and never
 * printed — not in a log line, not in an error, not in the JSON envelope. Only
 * whether it is set is ever reported.
 *
 * A failed hook is the one case where the correct behaviour is deliberately
 * *not* to undo anything: the content is already activated and a build from it
 * is valid. Rolling the pointer back would discard a good release because a
 * notification failed. The command fails with the exact retry command instead.
 */

export const MAX_DEPLOY_TRIES = 3;
export const DEFAULT_DEPLOY_TIMEOUT_MS = 15_000;

export interface DeployTrigger {
  readonly releaseId: string;
  readonly reason: "publish" | "rollback" | "deploy-only";
}

export interface DeployOutcome {
  /** True when the hook accepted the request. */
  readonly triggered: boolean;
  readonly status: number | null;
  readonly attempts: number;
}

export interface DeployHook {
  /** A description safe to print: never the URL itself. */
  readonly label: string;
  /** How many HTTP requests this hook actually issued. */
  readonly calls: number;
  trigger(trigger: DeployTrigger): Promise<DeployOutcome>;
}

/** Never contacts anything; counts nothing. Used for every dry run. */
export class DryRunDeployHook implements DeployHook {
  readonly label = "deploy hook (dry run, not contacted)";
  calls = 0;

  trigger(): Promise<DeployOutcome> {
    return Promise.resolve({ triggered: false, status: null, attempts: 0 });
  }
}

/**
 * The retry instruction a failed hook leaves behind.
 *
 * `--deploy-only` re-triggers the build for a release that is already active;
 * it re-reads `active.json` and refuses if the pointer no longer names that
 * release, so it can never deploy something that is not the live content.
 */
export function deployRetryInstruction(releaseId: string): string {
  return `pnpm content:publish --deploy-only --release ${releaseId} --apply`;
}

export class DeployFailedError extends RemoteError {
  readonly releaseId: string;

  constructor(
    releaseId: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `${message} The content is already active and was not rolled back. Retry with: ${deployRetryInstruction(releaseId)}`,
      options,
    );
    this.name = "DeployFailedError";
    this.releaseId = releaseId;
  }
}

export interface HttpDeployHookOptions {
  readonly url: string;
  readonly fetch: FetchLike;
  readonly retry?: RetryDependencies;
  readonly maxTries?: number;
  /** Maximum time one HTTP attempt may wait for the hook to answer. */
  readonly timeoutMs?: number;
  /** Called before each attempt, for a human-readable "attempt 2 of 3". */
  readonly onAttempt?: (attempt: number, maxTries: number) => void;
}

function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export class HttpDeployHook implements DeployHook {
  readonly label = "Cloudflare Pages deploy hook (CF_PAGES_DEPLOY_HOOK_URL)";
  calls = 0;

  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #maxTries: number;
  readonly #retry: RetryDependencies;
  readonly #timeoutMs: number;
  readonly #onAttempt:
    ((attempt: number, maxTries: number) => void) | undefined;

  constructor(options: HttpDeployHookOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch;
    this.#maxTries = Math.max(1, options.maxTries ?? MAX_DEPLOY_TRIES);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError(
        "The deploy hook timeout must be a positive number.",
      );
    }
    this.#retry = options.retry ?? {};
    this.#onAttempt = options.onAttempt;
  }

  async trigger(trigger: DeployTrigger): Promise<DeployOutcome> {
    const sleep =
      this.#retry.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = this.#retry.random ?? Math.random;

    let lastFailure = "no attempt was made";

    for (let attempt = 1; attempt <= this.#maxTries; attempt += 1) {
      this.#onAttempt?.(attempt, this.#maxTries);
      this.calls += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            releaseId: trigger.releaseId,
            reason: trigger.reason,
          }),
        });

        if (response.ok) {
          return {
            triggered: true,
            status: response.status,
            attempts: attempt,
          };
        }

        lastFailure = `the deploy hook responded with HTTP ${response.status}`;
        if (!isTransient(response.status)) {
          // A 4xx will not start working on a second attempt.
          throw new DeployFailedError(
            trigger.releaseId,
            `Deploy hook failed: ${lastFailure}.`,
          );
        }
      } catch (error) {
        if (error instanceof DeployFailedError) throw error;
        lastFailure = controller.signal.aborted
          ? `the request timed out after ${this.#timeoutMs} ms`
          : error instanceof Error
            ? error.message
            : String(error);
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.#maxTries) {
        const delay =
          Math.min(4_000, 250 * 2 ** (attempt - 1)) * (1 + 0.25 * random());
        await sleep(Math.round(delay));
      }
    }

    throw new DeployFailedError(
      trigger.releaseId,
      `Deploy hook failed after ${this.#maxTries} attempts: ${lastFailure}.`,
    );
  }
}
