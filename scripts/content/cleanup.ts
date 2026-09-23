import "../lib/env.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import { EXIT, UsageError, type ExitCode } from "../lib/errors.js";
import { formatBytes, messageOf } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import { readActive } from "../release/active.js";
import {
  assertPlanActionable,
  assertPlanDigest,
  cleanupPlanDigest,
  describeCleanupPlan,
  planCleanup,
  type CleanupPlan,
} from "../release/cleanup-plan.js";
import {
  collectInventory,
  toCleanupInput,
  type BucketInventory,
} from "../release/inventory.js";
import { acquireMutationLease } from "../release/lease.js";
import type { ReleasePorts } from "../release/ports.js";
import type { StorageAdapter } from "../release/storage.js";

/**
 * `content:cleanup` — delete releases and media that nothing refers to.
 *
 * This is the only command that destroys data, so it is the most conservative
 * one:
 *
 * - a plan is computed from a complete listing of both buckets, and the plan
 *   itself is reduced to a canonical digest;
 * - a plan whose media deletions had to be withheld — because a release that
 *   survives has no readable manifest — is marked incomplete and is never
 *   applied, whatever digest is supplied;
 * - `--apply` requires that digest, re-reads everything, and recomputes the
 *   plan. If anything at all has changed — a new release, a moved pointer, a
 *   media object that has appeared — the digests differ and the command exits
 *   with code 7 without deleting anything;
 * - deletes are never retried. When one fails, the object is re-read: if the
 *   bucket says it is gone the delete succeeded, and otherwise — including when
 *   the re-read itself fails — the failure is real and is reported.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "plan",
    kind: "string",
    value: "<digest>",
    summary: "Required with --apply. The plan digest printed by the dry run.",
  },
];

export const cleanupDefinition: CliDefinition = {
  command: "content:cleanup",
  summary:
    "Compute a safe retention plan and (with --apply --plan <digest>) delete what it lists.",
  usage: [
    "content:cleanup [--json]",
    "content:cleanup --apply --plan <digest>",
  ],
  flags: FLAGS,
  notes: [
    "Keeps the active release, the 10 most recent complete releases, everything under 90 days old, and all media they reference.",
    "--apply requires the exact plan digest from a dry run, and re-verifies it before deleting.",
    "Uses the cleanup credentials, which are only read by this command.",
  ],
  handler: handleCleanup,
};

interface PlanSnapshot {
  readonly plan: CleanupPlan;
  readonly digest: string;
  readonly inventory: BucketInventory;
}

async function computePlan(
  context: CliContext,
  ports: ReleasePorts,
  onProgress: (message: string) => void,
): Promise<PlanSnapshot> {
  const active = await readActive(ports.content);
  const inventory = await collectInventory({
    content: ports.content,
    media: ports.media,
    activeReleaseId: active.pointer?.releaseId ?? null,
    onProgress,
  });

  const plan = planCleanup(
    toCleanupInput(inventory, context.dependencies.now()),
  );
  return { plan, digest: cleanupPlanDigest(plan), inventory };
}

function reportPlan(context: CliContext, snapshot: PlanSnapshot): void {
  const { reporter } = context;
  const { plan } = snapshot;

  reporter.heading("Retention");
  reporter.note(`  kept releases  : ${plan.retained.length}`);
  if (plan.activeReleaseId !== null)
    reporter.note(`  active         : ${plan.activeReleaseId}`);
  reporter.note(`  kept media refs: ${plan.keepMedia.length}`);

  reporter.heading("Deletions");
  for (const object of plan.contentDeletes) {
    reporter.action("delete", object.key, { bytes: object.bytes });
  }
  for (const object of plan.mediaDeletes) {
    reporter.action("delete", object.key, { bytes: object.bytes });
  }
  if (plan.contentDeletes.length === 0 && plan.mediaDeletes.length === 0) {
    reporter.note("  nothing to delete");
  }
  if (plan.unrecognised.length > 0) {
    reporter.note(
      `  ${plan.unrecognised.length} object(s) do not match the release layout and are left untouched`,
    );
  }

  if (plan.incomplete !== null) {
    reporter.note(`  warning: ${plan.incomplete.reason}`);
  }

  reporter.note(`plan digest: ${snapshot.digest}`);
}

async function handleCleanup(context: CliContext): Promise<ExitCode> {
  const { reporter, flags } = context;
  const suppliedPlan = flags.string("plan");

  if (context.dryRun && suppliedPlan !== undefined) {
    throw new UsageError("--plan only applies together with --apply.");
  }
  if (context.apply && suppliedPlan === undefined) {
    throw new UsageError(
      "--apply requires --plan <digest>: run the dry run first and pass the digest it printed.",
    );
  }

  /*
   * Past this point `--apply` is the only way to reach the deletion code, and
   * the guard above has already refused a missing digest. Narrowing the type
   * here rather than at the use site keeps that reasoning in one place: the
   * `--plan` value is a plain string everywhere below.
   */
  const planDigest: string | undefined = context.apply
    ? suppliedPlan
    : undefined;

  if (context.dryRun) {
    const ports = context.dependencies.ports.create({
      role: "author",
      content: true,
      media: true,
      dryRun: true,
    });
    const snapshot = await computePlan(context, ports, (message) => {
      reporter.note(message);
    });
    reportPlan(context, snapshot);
    reporter.setSummary(`Dry run: ${describeCleanupPlan(snapshot.plan)}.`);
    return EXIT.OK;
  }

  const ports = context.dependencies.ports.create({
    role: "cleanup",
    content: true,
    media: true,
    dryRun: false,
  });

  const lease = await acquireMutationLease({
    storage: ports.content,
    operation: "cleanup",
    now: context.dependencies.now,
  });

  try {
    const snapshot = await computePlan(context, ports, (message) => {
      reporter.note(message);
    });

    if (planDigest === undefined) {
      throw new UsageError(
        "--apply requires --plan <digest>: run the dry run first and pass the digest it printed.",
      );
    }

    /*
     * Checked before the digest: when the plan had to be computed without a
     * usable manifest, the failure is "the bucket could not be read", not "the
     * bucket moved", and the message has to say so. Either way nothing is
     * deleted. A dry run still prints the plan — an operator needs to see which
     * releases are broken — but `--apply` refuses it.
     */
    assertPlanActionable(snapshot.plan);

    assertPlanDigest(snapshot.plan, planDigest);

    reportPlan(context, snapshot);

    let deleted = 0;
    let bytes = 0;
    const failures: string[] = [];

    const remove = async (
      storage: StorageAdapter,
      key: string,
      size: number,
    ): Promise<void> => {
      try {
        await storage.delete(key);
        deleted += 1;
        bytes += size;
        reporter.action("delete", key, { bytes: size });
      } catch (error) {
        /*
         * Never retried blindly: re-read the object and find out what is true.
         *
         * `head` returning null is the adapter saying "404 — it really is gone",
         * which makes the failed delete a success. A `head` that *throws* has
         * said nothing at all: the delete may or may not have happened. Treating
         * the two as one was the bug — a transport error became `deleted += 1`,
         * a printed "the object is gone" and exit code 0, over an object that was
         * still there.
         */
        let gone: boolean;
        try {
          gone = (await storage.head(key)) === null;
        } catch (headError) {
          failures.push(
            `${key}: ${messageOf(error)}; the object could not be re-read to confirm whether it is gone (${messageOf(headError)}).`,
          );
          return;
        }

        if (gone) {
          deleted += 1;
          bytes += size;
          reporter.action("delete", key, {
            bytes: size,
            detail: "report failed, but the object is gone",
          });
          return;
        }

        failures.push(`${key}: ${messageOf(error)}`);
      }
    };

    for (const object of snapshot.plan.contentDeletes) {
      await lease.renewIfNeeded();
      await remove(ports.content, object.key, object.bytes);
    }
    for (const object of snapshot.plan.mediaDeletes) {
      await lease.renewIfNeeded();
      await remove(ports.media, object.key, object.bytes);
    }

    if (failures.length > 0) {
      for (const failure of failures) reporter.error(new Error(failure));
      reporter.setSummary(
        `Deleted ${deleted} object(s) (${formatBytes(bytes)}); ${failures.length} could not be deleted.`,
      );
      return EXIT.REMOTE;
    }

    reporter.setSummary(`Deleted ${deleted} object(s), ${formatBytes(bytes)}.`);
    return EXIT.OK;
  } finally {
    await lease.release();
  }
}

export async function runCleanup(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(cleanupDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runCleanup(process.argv.slice(2));
}
