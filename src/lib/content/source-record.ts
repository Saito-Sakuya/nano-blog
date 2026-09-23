import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { ANI_CONTENT_DIR } from "./paths.js";

/**
 * The record describing where this build's content came from.
 *
 * Written by whichever step materialised the runtime — `prepare` for the
 * empty, workspace and fixture modes, and the release pull for the `r2` mode.
 * Both writers produce this exact shape, so a reader never has to guess which
 * one ran.
 */

export type ContentMode = "empty" | "workspace" | "fixtures" | "r2";

export const CONTENT_MODES: readonly ContentMode[] = [
  "empty",
  "workspace",
  "fixtures",
  "r2",
];

export interface SourceRecord {
  readonly schemaVersion: number;
  readonly mode: ContentMode;
  readonly releaseId: string | null;
  readonly contentDigest: string | null;
  readonly materializedAt: string;
  /**
   * True when the runtime was built from an already-verified local cache under
   * an explicit `--offline`, with no contact with R2 and no remote
   * verification. A build must say so on the page as well as in the terminal:
   * an offline build is reproducible from the cache, but nothing has confirmed
   * that the cache still matches what the bucket holds.
   */
  readonly offline?: boolean;
}

/**
 * A record that exists but cannot be believed.
 *
 * Distinct from `null`, which means "nothing was materialised". The difference
 * matters in the direction the page depends on: a corrupt record must not look
 * like an absent one, because an absent one renders no banner — and the fixture
 * and offline banners exist precisely so a reader is not shown test content or
 * an unverified cache as though it were the real site.
 */
export class SourceRecordError extends Error {
  override readonly name = "SourceRecordError";
}

export function sourceRecordPath(): string {
  return path.join(ANI_CONTENT_DIR, "runtime", "source.json");
}

function isContentMode(value: unknown): value is ContentMode {
  return (
    typeof value === "string" &&
    (CONTENT_MODES as readonly string[]).includes(value)
  );
}

/** An optional string field: a string as written, or `null` when absent. */
function optionalString(
  value: unknown,
  field: string,
  file: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new SourceRecordError(
      `${file}: ${field} must be a string or null, but is ${typeof value}.`,
    );
  }
  return value;
}

/**
 * Read a record from a specific file. See `readSourceRecord` for the contract;
 * this variant exists so the reader can be tested against a temporary file
 * rather than the build's own runtime directory.
 */
export function readSourceRecordFrom(file: string): SourceRecord | null {
  if (!existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SourceRecordError(
      `${file} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SourceRecordError(
      `${file} must contain a JSON object, but contains ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }

  const record = parsed as Record<string, unknown>;

  const mode = record["mode"];
  if (!isContentMode(mode)) {
    throw new SourceRecordError(
      `${file}: mode is ${JSON.stringify(mode)}, which is not one of ${CONTENT_MODES.join(", ")}.`,
    );
  }

  // A build reads this timestamp to say when the content it is serving was
  // materialised. An empty or unparsable value would surface as an
  // `Invalid time value` deep inside `Intl` instead of here.
  const materializedAt = record["materializedAt"];
  if (
    typeof materializedAt !== "string" ||
    Number.isNaN(Date.parse(materializedAt))
  ) {
    throw new SourceRecordError(
      `${file}: materializedAt must be an ISO 8601 timestamp, but is ${JSON.stringify(materializedAt)}.`,
    );
  }

  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== undefined && typeof schemaVersion !== "number") {
    throw new SourceRecordError(
      `${file}: schemaVersion must be a number when present, but is ${typeof schemaVersion}.`,
    );
  }

  return {
    schemaVersion: schemaVersion ?? 1,
    mode,
    releaseId: optionalString(record["releaseId"], "releaseId", file),
    contentDigest: optionalString(
      record["contentDigest"],
      "contentDigest",
      file,
    ),
    materializedAt,
    offline: record["offline"] === true,
  };
}

/**
 * Read the record the current build wrote.
 *
 * A missing file is a legitimate state — a build that never ran a
 * materialisation step — and yields `null` rather than throwing. A file that is
 * present but damaged throws `SourceRecordError`: the caller cannot tell the
 * two apart from `null`, and quietly rendering no banner is the failure this
 * record exists to prevent.
 */
export function readSourceRecord(): SourceRecord | null {
  return readSourceRecordFrom(sourceRecordPath());
}
