import { ValidationError } from "../lib/errors.js";
import type {
  CleanupInput,
  ListedObjectRecord,
  ManifestState,
  ReleaseInventory,
} from "./cleanup-plan.js";
import { releaseIdFromKey, parseManifest, CONTENT_LIMITS } from "./manifest.js";
import type { StorageAdapter } from "./storage.js";

/**
 * Reading the bucket to decide what may be deleted.
 *
 * Every listing is complete: `StorageAdapter.list` follows continuation tokens,
 * so a bucket with more than a thousand objects is not silently truncated into
 * a plan that deletes things it never saw.
 *
 * A release counts as *complete* only when its manifest is present and valid.
 * An interrupted upload is therefore never treated as a recent release — but
 * its objects are still protected by the age rule, so a plan cannot delete a
 * release that is being uploaded right now.
 *
 * A manifest that could not be read is recorded as its own state rather than
 * folded into "incomplete". The two are not the same thing: an interrupted
 * upload is expected in a bucket, while a manifest that exists and will not
 * parse is a failure to observe the bucket, and the media that its release
 * references are unknown as a result. `planCleanup` refuses to delete any media
 * while a retained release is in that state.
 */

export interface BucketInventory {
  readonly contentObjects: readonly ListedObjectRecord[];
  readonly mediaObjects: readonly ListedObjectRecord[];
  readonly releases: readonly ReleaseInventory[];
  readonly activeReleaseId: string | null;
}

export interface InventoryProgress {
  (message: string): void;
}

/** Every object in a bucket, one page at a time. */
export async function listAllObjects(
  storage: StorageAdapter,
): Promise<ListedObjectRecord[]> {
  const objects: ListedObjectRecord[] = [];
  for await (const summary of storage.list("")) {
    objects.push({
      key: summary.key,
      bytes: summary.bytes,
      lastModified: summary.lastModified,
    });
  }
  objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return objects;
}

export async function collectInventory(options: {
  readonly content: StorageAdapter;
  readonly media: StorageAdapter;
  readonly activeReleaseId: string | null;
  readonly onProgress?: InventoryProgress;
}): Promise<BucketInventory> {
  const contentObjects = await listAllObjects(options.content);
  options.onProgress?.(`listed ${contentObjects.length} content object(s)`);

  const grouped = new Map<string, ListedObjectRecord[]>();
  for (const object of contentObjects) {
    const releaseId = releaseIdFromKey(object.key);
    if (releaseId === null) continue;
    const bucket = grouped.get(releaseId);
    if (bucket === undefined) {
      grouped.set(releaseId, [object]);
    } else {
      bucket.push(object);
    }
  }

  const releases: ReleaseInventory[] = [];

  for (const [releaseId, objects] of [...grouped.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const manifestObject = objects.find(
      (object) => object.key === `releases/${releaseId}/manifest.json`,
    );
    let manifestState: ManifestState = "missing";
    let referencedMedia: string[] = [];

    if (manifestObject !== undefined) {
      try {
        const data = await options.content.get(manifestObject.key, {
          maxBytes: CONTENT_LIMITS.manifestBytes,
        });
        const manifest = parseManifest(
          JSON.parse(Buffer.from(data.bytes).toString("utf8")),
          manifestObject.key,
        );
        if (manifest.releaseId !== releaseId) {
          throw new ValidationError(
            `it declares release ${manifest.releaseId}, not ${releaseId}`,
          );
        }
        manifestState = "valid";
        referencedMedia = manifest.media.map((entry) => entry.path);
      } catch (error) {
        manifestState = "unreadable";
        options.onProgress?.(
          `warning: ${manifestObject.key} could not be read (${error instanceof Error ? error.message : String(error)}); the media it references is unknown, so media cleanup will refuse to delete anything until this manifest can be read.`,
        );
      }
    }

    releases.push({
      releaseId,
      manifestState,
      objects,
      referencedMedia,
    });
  }

  const mediaObjects = await listAllObjects(options.media);
  options.onProgress?.(`listed ${mediaObjects.length} media object(s)`);

  return {
    contentObjects,
    mediaObjects,
    releases,
    activeReleaseId: options.activeReleaseId,
  };
}

export function toCleanupInput(
  inventory: BucketInventory,
  now: Date,
): CleanupInput {
  return {
    releases: inventory.releases,
    activeReleaseId: inventory.activeReleaseId,
    contentObjects: inventory.contentObjects,
    mediaObjects: inventory.mediaObjects,
    now,
  };
}
