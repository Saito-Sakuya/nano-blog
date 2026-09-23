/**
 * Bounded parallel work.
 *
 * `content:pull` downloads a release with a fixed limit of 8 concurrent
 * requests, so it neither serialises a hundred files into a slow queue nor
 * opens a hundred sockets at a bucket that answers with 429 above some rate.
 *
 * The first failure stops new work from starting and is rethrown once the
 * in-flight items settle, so a failed download cannot leave workers running
 * behind the error path.
 */

export const DEFAULT_CONCURRENCY = 8;

export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];

  /*
   * `NaN` is the one limit that cannot be repaired: `Math.trunc(NaN)` is `NaN`,
   * every comparison against it is false, and the loop below would start no
   * workers at all — an empty result array that looks like "there was nothing
   * to do". A caller that computed the limit from a flag or a config value has
   * a bug, and it is reported as one.
   */
  if (Number.isNaN(limit)) {
    throw new RangeError(
      `mapWithConcurrency needs a numeric limit, but received ${String(limit)}.`,
    );
  }

  const effectiveLimit = Math.max(1, Math.min(Math.trunc(limit), items.length));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  const run = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index];
      if (item === undefined) continue;

      try {
        results[index] = await worker(item, index);
      } catch (error) {
        /*
         * The flag is what says "something failed", not the value: a worker
         * that throws `undefined` (or a rejected promise with no reason) used
         * to leave `failure === undefined`, so the failure was neither
         * rethrown nor seen by the other workers, and the caller received a
         * result array with a hole in it.
         */
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => run()));

  if (failed) throw failure;
  return results;
}
