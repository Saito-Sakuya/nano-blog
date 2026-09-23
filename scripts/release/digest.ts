import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

/**
 * Hashing, digests and release identifiers.
 *
 * A release id is a UTC timestamp followed by the first twelve hex characters
 * of the release content digest:
 *
 *     20260915T080000Z-0123456789ab
 *
 * The digest part is what makes the id meaningful — the same content published
 * twice produces the same suffix, so a republish is recognised as idempotent
 * instead of looking like a new release.
 */

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const RELEASE_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/u;

/** Bytes of the digest embedded in a release id, in hex characters. */
export const DIGEST_SUFFIX_LENGTH = 12;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:<64 lowercase hex>`, the form every digest field uses. */
export function sha256Digest(data: Uint8Array | string): string {
  return `sha256:${sha256Hex(data)}`;
}

/** The digest of a value's canonical JSON form. */
export function canonicalDigest(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}

/** The twelve hex characters a release id embeds. */
export function shortDigest(digest: string): string {
  const hex = digest.startsWith("sha256:")
    ? digest.slice("sha256:".length)
    : digest;
  return hex.slice(0, DIGEST_SUFFIX_LENGTH);
}

export function isContentDigest(value: string): boolean {
  return CONTENT_DIGEST_PATTERN.test(value);
}

export function isReleaseId(value: string): boolean {
  return RELEASE_ID_PATTERN.test(value);
}

/** `YYYYMMDDTHHmmssZ`, always UTC. */
export function formatReleaseTimestamp(instant: Date): string {
  const iso = instant.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** The release id for an instant and a content digest. */
export function releaseIdFor(instant: Date, digest: string): string {
  return `${formatReleaseTimestamp(instant)}-${shortDigest(digest)}`;
}

export interface ParsedReleaseId {
  /** `YYYYMMDDTHHmmssZ`. */
  readonly timestamp: string;
  readonly digest12: string;
  /** The instant the release id names. */
  readonly instant: Date;
}

export function parseReleaseId(value: string): ParsedReleaseId | null {
  if (!isReleaseId(value)) return null;

  const timestamp = value.slice(0, 16);
  const instant = new Date(
    `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.000Z`,
  );
  if (Number.isNaN(instant.getTime())) return null;

  return { timestamp, digest12: value.slice(17), instant };
}

/**
 * Release ids sort lexicographically in the same order they sort
 * chronologically, because the timestamp is fixed-width and UTC.
 */
export function compareReleaseIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ISO 8601 with milliseconds, UTC — the form `createdAt` uses. */
export function toInstantString(instant: Date): string {
  return instant.toISOString();
}
