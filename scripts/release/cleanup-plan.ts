import { StalePlanError, ValidationError } from "../lib/errors.js";
import { formatBytes } from "../lib/fs-util.js";
import { sortByCodePoints } from "../lib/unicode.js";
import { canonicalDigest, parseReleaseId } from "./digest.js";
import { releaseIdFromKey } from "./manifest.js";

/**
 * Cleanup retention.
 *
 * Four things are kept, and everything else has to earn its deletion:
 *
 * 1. the active release, always;
 * 2. the ten most recent *complete* releases;
 * 3. every release less than 90 days old, complete or not, because a release
 *    being uploaded right now is not garbage;
 * 4. every media object referenced by any retained manifest.
 *
 * An object is only deletable when it is over 90 days old *and* belongs to no
 * retained release *and* is referenced by no retained manifest. A plan is a
 * canonical digest of exactly those lists, so `--apply --plan <digest>` cannot
 * be run against a bucket that has moved on: the digest simply will not match.
 *
 * Rule 4 depends on being able to *read* the manifests of the retained
 * releases, and that is the one input this module cannot recompute. A manifest
 * that could not be fetched, or that no longer parses, leaves the media that
 * its release references unknown — and a release can be retained without a
 * readable manifest (the active one always is; so is anything under 90 days
 * old). Deleting media on top of that hole would delete the cover of a live
 * release, so the plan fails closed instead: any retained release with an
 * unusable manifest withholds **every** media deletion, marks the plan
 * incomplete, and `assertPlanActionable` refuses to let `--apply` run. Content
 * deletions are unaffected — they are decided by key and age, not by manifest
 * contents — but nothing is applied while the plan is incomplete.
 *
 * Objects that do not fit the documented key layout are never deleted. This
 * command removes releases; it does not tidy up things it does not understand.
 */

export const CLEANUP_RETENTION = {
  recentReleases: 10,
  maxAgeDays: 90,
} as const;

export interface ListedObjectRecord {
  readonly key: string;
  readonly bytes: number;
  readonly lastModified: Date | null;
}

/**
 * What the inventory knows about a release's manifest.
 *
 * - `valid` — present, parsed and verified. `referencedMedia` is complete.
 * - `missing` — the upload never got as far as writing one.
 * - `unreadable` — present, but it could not be fetched or did not parse.
 *
 * The last two are the same kind of hole: the release's own objects are still
 * protected by the age rule, but nothing is known about the media it
 * references.
 */
export type ManifestState = "valid" | "missing" | "unreadable";

export interface ReleaseInventory {
  readonly releaseId: string;
  /**
   * Whether the release's manifest could be used. Only `valid` makes
   * `referencedMedia` meaningful, and only `valid` counts as *complete* for the
   * "ten most recent releases" rule.
   */
  readonly manifestState: ManifestState;
  /** Objects under `releases/<id>/`. */
  readonly objects: readonly ListedObjectRecord[];
  /** Media paths (`/media/…`) its manifest references; empty unless valid. */
  readonly referencedMedia: readonly string[];
}

export interface CleanupInput {
  readonly releases: readonly ReleaseInventory[];
  readonly activeReleaseId: string | null;
  /** Every object in the content bucket, including `active.json`. */
  readonly contentObjects: readonly ListedObjectRecord[];
  /** Every object in the media bucket. */
  readonly mediaObjects: readonly ListedObjectRecord[];
  readonly now: Date;
  readonly retention?: {
    readonly recentReleases: number;
    readonly maxAgeDays: number;
  };
}

export interface CleanupPlanObject {
  readonly key: string;
  readonly bytes: number;
}

/**
 * Why a plan may not be applied.
 *
 * Only one cause exists today — a retained release whose manifest could not be
 * read — and it is recorded as data rather than as a message so a caller can
 * report the offending releases without parsing prose.
 */
export interface CleanupPlanIncomplete {
  /** The retained releases whose manifests were not usable. */
  readonly releases: readonly string[];
  /** One sentence naming the cause and the fix. */
  readonly reason: string;
}

export interface CleanupPlan {
  readonly schemaVersion: number;
  readonly activeReleaseId: string | null;
  readonly retained: readonly string[];
  readonly contentDeletes: readonly CleanupPlanObject[];
  readonly mediaDeletes: readonly CleanupPlanObject[];
  readonly keepMedia: readonly string[];
  /** Objects whose keys do not match the documented layout; never deleted. */
  readonly unrecognised: readonly string[];
  /**
   * Set when the plan is not trustworthy enough to act on. `mediaDeletes` is
   * empty whenever this is set, and `assertPlanActionable` refuses `--apply`.
   */
  readonly incomplete: CleanupPlanIncomplete | null;
  readonly totals: {
    readonly contentCount: number;
    readonly contentBytes: number;
    readonly mediaCount: number;
    readonly mediaBytes: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ageInDays(lastModified: Date | null, now: Date): number | null {
  if (lastModified === null) return null;
  const delta = now.getTime() - lastModified.getTime();
  return delta / DAY_MS;
}

function isOldEnough(
  lastModified: Date | null,
  now: Date,
  maxAgeDays: number,
): boolean {
  const age = ageInDays(lastModified, now);
  // An object with no timestamp is not provably old, so it is kept.
  if (age === null) return false;
  return age >= maxAgeDays;
}

/** The release id timestamp, or the newest object timestamp as a fallback. */
function releaseInstant(release: ReleaseInventory): Date | null {
  const parsed = parseReleaseId(release.releaseId);
  if (parsed !== null) return parsed.instant;

  let newest: Date | null = null;
  for (const object of release.objects) {
    if (object.lastModified === null) continue;
    if (newest === null || object.lastModified.getTime() > newest.getTime()) {
      newest = object.lastModified;
    }
  }
  return newest;
}

function isReleaseOldEnough(
  release: ReleaseInventory,
  now: Date,
  maxAgeDays: number,
): boolean {
  const instant = releaseInstant(release);
  if (instant === null) return false;
  return (now.getTime() - instant.getTime()) / DAY_MS >= maxAgeDays;
}

export function planCleanup(input: CleanupInput): CleanupPlan {
  const retention = input.retention ?? CLEANUP_RETENTION;

  // --- the retention set ---------------------------------------------------

  const retained = new Set<string>();
  if (input.activeReleaseId !== null) retained.add(input.activeReleaseId);

  const complete = input.releases
    .filter((release) => release.manifestState === "valid")
    .map((release) => release.releaseId)
    .sort()
    .reverse();
  for (const releaseId of complete.slice(0, retention.recentReleases))
    retained.add(releaseId);

  for (const release of input.releases) {
    if (!isReleaseOldEnough(release, input.now, retention.maxAgeDays)) {
      retained.add(release.releaseId);
    }
  }

  // --- media that must survive --------------------------------------------

  const keepMedia = new Set<string>();
  /*
   * A manifest records the concrete path an article referenced, but one media
   * asset is a family: meta.json, the sanitised original and every responsive
   * derivative all live below media/<source digest>/. Keeping only the one
   * referenced variant makes the remaining files look unreferenced and lets a
   * later cleanup break srcset (or remove the metadata needed by a build).
   *
   * Keep the exact paths in the public plan for auditability, and use the
   * source digest as the actual retention key.
   */
  const keepMediaDigests = new Set<string>();
  for (const release of input.releases) {
    if (!retained.has(release.releaseId)) continue;
    for (const mediaPath of release.referencedMedia) {
      const key = mediaPath.startsWith("/") ? mediaPath.slice(1) : mediaPath;
      keepMedia.add(key);
      const digest = /^media\/([0-9a-f]{64})\//u.exec(key)?.[1];
      if (digest !== undefined) keepMediaDigests.add(digest);
    }
  }

  /*
   * A retained release with no readable manifest is a hole in the protection
   * set: the media it references cannot be named, so it cannot be kept. Rather
   * than delete on incomplete information — which is how the cover of a live
   * release gets removed — no media deletion is computed at all.
   *
   * A release that is *not* retained does not block anything: its own objects
   * and media are on their way out regardless of what its manifest said.
   */
  const unreadable = sortByCodePoints(
    input.releases
      .filter(
        (release) =>
          retained.has(release.releaseId) && release.manifestState !== "valid",
      )
      .map((release) => release.releaseId),
  );

  const incomplete: CleanupPlanIncomplete | null =
    unreadable.length === 0
      ? null
      : {
          releases: unreadable,
          reason: `${unreadable.length} retained release(s) have no readable manifest (${unreadable.join(", ")}), so the media they reference is unknown and cannot be protected. Repair manifest access first — re-read those manifests from the content bucket and re-run the cleanup — then clean up.`,
        };

  // --- content deletions ---------------------------------------------------

  const contentDeletes: CleanupPlanObject[] = [];
  const unrecognised: string[] = [];

  for (const object of input.contentObjects) {
    if (object.key === "active.json") continue;

    const releaseId = releaseIdFromKey(object.key);
    if (releaseId === null) {
      if (object.key.startsWith("releases/")) unrecognised.push(object.key);
      continue;
    }

    if (retained.has(releaseId)) continue;
    if (!isOldEnough(object.lastModified, input.now, retention.maxAgeDays))
      continue;

    contentDeletes.push({ key: object.key, bytes: object.bytes });
  }

  // --- media deletions -----------------------------------------------------

  const mediaDeletes: CleanupPlanObject[] = [];

  if (incomplete === null) {
    for (const object of input.mediaObjects) {
      const digest = /^media\/([0-9a-f]{64})\//u.exec(object.key)?.[1];
      if (digest !== undefined && keepMediaDigests.has(digest)) continue;
      if (!isOldEnough(object.lastModified, input.now, retention.maxAgeDays))
        continue;

      if (!/^media\/[0-9a-f]{64}\//u.test(object.key)) {
        unrecognised.push(object.key);
        continue;
      }

      mediaDeletes.push({ key: object.key, bytes: object.bytes });
    }
  } else {
    /*
     * The media bucket still has to be classified, but nothing in it may be
     * deleted: an unrecognised key is reported, and a recognised one is left
     * alone. Reporting them keeps the "objects outside the layout are never
     * touched" rule visible instead of silently dropping the section.
     */
    for (const object of input.mediaObjects) {
      if (!/^media\/[0-9a-f]{64}\//u.test(object.key)) {
        unrecognised.push(object.key);
      }
    }
  }

  contentDeletes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  mediaDeletes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    schemaVersion: 1,
    activeReleaseId: input.activeReleaseId,
    retained: sortByCodePoints([...retained]),
    contentDeletes,
    mediaDeletes,
    keepMedia: sortByCodePoints([...keepMedia]),
    unrecognised: sortByCodePoints(unrecognised),
    incomplete,
    totals: {
      contentCount: contentDeletes.length,
      contentBytes: contentDeletes.reduce(
        (total, object) => total + object.bytes,
        0,
      ),
      mediaCount: mediaDeletes.length,
      mediaBytes: mediaDeletes.reduce(
        (total, object) => total + object.bytes,
        0,
      ),
    },
  };
}

/**
 * The canonical digest of a plan.
 *
 * Byte counts are included but timestamps are not: a plan re-computed a minute
 * later against unchanged state must produce the same digest, while a bucket
 * that gained or lost an object must not.
 */
export function cleanupPlanDigest(plan: CleanupPlan): string {
  return canonicalDigest({
    schemaVersion: plan.schemaVersion,
    activeReleaseId: plan.activeReleaseId,
    retained: plan.retained,
    contentDeletes: plan.contentDeletes.map((object) => ({
      key: object.key,
      bytes: object.bytes,
    })),
    mediaDeletes: plan.mediaDeletes.map((object) => ({
      key: object.key,
      bytes: object.bytes,
    })),
    // The blocked releases are part of the digest on purpose: a plan whose
    // media deletions were withheld is a different plan from one that simply
    // had nothing to delete, and `--apply` must never accept the first while
    // claiming it reviewed the second.
    incomplete: plan.incomplete === null ? null : plan.incomplete.releases,
  });
}

/**
 * Refuse to act on a plan that could not be computed in full.
 *
 * The plan is still printable, and the dry run still prints it: an operator
 * needs to see which releases are broken in order to fix them. What is refused
 * is the deletion, because the lists were built on top of a manifest that could
 * not be read.
 */
export function assertPlanActionable(plan: CleanupPlan): void {
  if (plan.incomplete === null) return;
  throw new ValidationError(plan.incomplete.reason);
}

/**
 * Refuse to act on a plan that no longer describes the bucket.
 *
 * `--apply` must carry the digest of the plan the author reviewed, and the
 * digest is recomputed here from a fresh listing. A mismatch means the remote
 * state moved between the two commands, so nothing is deleted. The error is a
 * `StalePlanError` — exit 7 — rather than a validation failure: the plan was
 * valid when it was printed, and what changed is the world, not the input.
 */
export function assertPlanDigest(plan: CleanupPlan, expected: string): void {
  const actual = cleanupPlanDigest(plan);
  if (actual !== expected) {
    throw new StalePlanError(
      `The plan digest is now ${actual}, but --plan supplied ${expected}. The bucket changed since the plan was made; not deleting anything.`,
    );
  }
}

export function describeCleanupPlan(plan: CleanupPlan): string {
  const parts = [
    `keeping ${plan.retained.length} release(s)`,
    `deleting ${plan.totals.contentCount} content object(s) (${formatBytes(plan.totals.contentBytes)})`,
    `deleting ${plan.totals.mediaCount} media object(s) (${formatBytes(plan.totals.mediaBytes)})`,
  ];
  if (plan.incomplete !== null) {
    parts.push(
      `INCOMPLETE: media deletions withheld because ${plan.incomplete.releases.length} retained release manifest(s) could not be read; --apply will be refused`,
    );
  }
  if (plan.unrecognised.length > 0) {
    parts.push(
      `${plan.unrecognised.length} unrecognised object(s) left untouched`,
    );
  }
  return parts.join(", ");
}
