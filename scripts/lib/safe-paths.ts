import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import { ValidationError } from "./errors.js";
import {
  compareCodePoints,
  foldCase,
  hasControlCharacters,
} from "./unicode.js";

/**
 * Path safety.
 *
 * A key or a path arriving from a manifest, a workspace file or a remote
 * listing is treated as untrusted input. The rules here are the ones the
 * specification lists — no absolute paths, no `..`, no backslashes, no NUL, and
 * no two paths that differ only by case or Unicode normalisation — plus the
 * three Windows-specific shapes that a Linux build would otherwise accept and a
 * Windows checkout could not materialise:
 *
 * - **Reserved device names.** `posts/con.md` is the console device, not a
 *   file, and `nul.txt` is the null device; both are reserved in every
 *   directory. A release containing one cannot be checked out on Windows at
 *   all.
 * - **Alternate data streams.** `dir/a:b.txt` is not a file called `a:b.txt`:
 *   on NTFS it writes into the `b.txt` stream of `dir/a`, which no directory
 *   listing and no `git status` shows, and which a later `dir/a` deletion takes
 *   with it. `C:/…` — an absolute Windows path — is refused by the same rule.
 * - **Over-long segments.** NTFS allows 255 UTF-16 code units per component and
 *   most Linux filesystems 255 bytes; a longer segment is refused here rather
 *   than accepted now and unmaterialisable later. Both limits are checked, so
 *   neither platform gets a path the other cannot store.
 *
 * `isInsideDirectory` and `resolveWithin` are a *lexical* check: they compare
 * resolved path strings and never follow a symlink, so a link *below* the root
 * is not detected — the root is what a caller names and controls.
 * `resolveWithin` additionally refuses a root that is itself a symbolic link,
 * because then every "inside the root" answer is really about the link's
 * target.
 */

/**
 * The longest a single path segment may be, in UTF-16 code units and in UTF-8
 * bytes. See the module comment.
 */
export const MAX_SEGMENT_LENGTH = 255;

/**
 * Names Windows resolves to a device in every directory, whatever the
 * extension: `CON`, `CON.md` and `nul.txt` are all devices, not files. Taken
 * from Microsoft's own list rather than guessed, so a legitimate file name is
 * not refused.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** True when a segment names a device rather than a file. */
function isReservedDeviceName(segment: string): boolean {
  // `CON.txt` is reserved too, so only the part before the first dot counts.
  const stem = segment.split(".", 1)[0] ?? segment;
  return WINDOWS_RESERVED_NAMES.has(stem.toUpperCase());
}

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  if (hasControlCharacters(value)) return false;
  if (value.startsWith("/")) return false;
  // A colon is a drive letter (`C:/…`) or an NTFS alternate data stream
  // (`dir/a:b.txt`); neither is a path this project may materialise.
  if (value.includes(":")) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("//")) return false;

  for (const segment of value.split("/")) {
    if (segment.length === 0) return false;
    if (segment === "." || segment === "..") return false;
    if (segment.endsWith(" ") || segment.endsWith(".")) return false;
    if (isReservedDeviceName(segment)) return false;
    if (
      segment.length > MAX_SEGMENT_LENGTH ||
      Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_LENGTH
    ) {
      return false;
    }
  }

  return true;
}

export function assertSafeRelativePath(value: string, label: string): void {
  if (!isSafeRelativePath(value)) {
    throw new ValidationError(
      `${label} is not a safe relative path: ${JSON.stringify(value)}. Absolute paths, "..", backslashes, NUL bytes, colons (drive letters and NTFS alternate data streams), Windows device names, segments longer than ${MAX_SEGMENT_LENGTH} units, and trailing spaces or dots are rejected.`,
    );
  }
}

/**
 * True when `candidate` is `parentDir` itself or lives inside it.
 *
 * Lexical on purpose: the two paths are resolved and compared as strings, and
 * nothing is read from the filesystem. That makes it usable for a destination
 * that does not exist yet, and it means a symlink *inside* the tree is not seen
 * — use `resolveWithin` when the result is about to be written.
 */
export function isInsideDirectory(
  parentDir: string,
  candidate: string,
): boolean {
  const parent = path.resolve(parentDir);
  const target = path.resolve(candidate);
  if (parent === target) return true;
  const relative = path.relative(parent, target);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function assertInsideDirectory(
  parentDir: string,
  candidate: string,
  label: string,
): void {
  if (!isInsideDirectory(parentDir, candidate)) {
    throw new ValidationError(
      `${label} must stay inside ${parentDir}, but resolved to ${path.resolve(candidate)}.`,
    );
  }
}

/**
 * Refuse a root that is itself a symbolic link.
 *
 * The lexical check cannot see links, and a linked root makes every later
 * "inside the root" answer a statement about the link's target instead — the
 * guarantee the caller asked for is about a directory nobody named. A root that
 * does not exist yet is not a link, so this passes and the caller can create
 * it; an unreadable root is left to fail where it is actually used.
 */
function assertRootIsNotSymbolicLink(parentDir: string, label: string): void {
  let info: Stats;
  try {
    info = lstatSync(parentDir);
  } catch {
    return;
  }

  if (info.isSymbolicLink()) {
    throw new ValidationError(
      `${label}: the root ${parentDir} is a symbolic link. Resolving inside it would escape the directory the caller named, so paths are refused rather than written through it.`,
    );
  }
}

/** Resolve a relative path under `parentDir`, refusing anything that escapes it. */
export function resolveWithin(
  parentDir: string,
  relativePath: string,
  label: string,
): string {
  assertSafeRelativePath(relativePath, label);
  assertRootIsNotSymbolicLink(parentDir, label);
  const resolved = path.resolve(parentDir, relativePath);
  assertInsideDirectory(parentDir, resolved, label);
  return resolved;
}

export interface PathCollision {
  readonly a: string;
  readonly b: string;
  readonly folded: string;
}

/**
 * The first pair of paths that collide once NFC-normalised and case-folded.
 *
 * `A.md` and `a.md` are different files on Linux and the same file on Windows;
 * the release must not contain both, whichever machine builds it.
 */
export function findCaseInsensitiveCollision(
  paths: readonly string[],
): PathCollision | undefined {
  const seen = new Map<string, string>();

  for (const value of paths) {
    const folded = foldCase(value.normalize("NFC"));
    const previous = seen.get(folded);
    if (previous !== undefined && previous !== value) {
      return { a: previous, b: value, folded };
    }
    seen.set(folded, value);
  }

  return undefined;
}

export function assertNoCaseCollisions(
  paths: readonly string[],
  label: string,
): void {
  const collision = findCaseInsensitiveCollision(paths);
  if (collision !== undefined) {
    throw new ValidationError(
      `${label} contains paths that collide on a case-insensitive filesystem: ${collision.a} and ${collision.b}.`,
    );
  }
}

/** Sort paths by Unicode code point, ascending, without mutating the input. */
export function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort(compareCodePoints);
}

/**
 * True when a `/media/...` path is a content-addressed media object.
 *
 * The file name is held to the same rules as any other path this project
 * materialises: a manifest is untrusted input, and `/media/<sha>/con.md` or
 * `/media/<sha>/a:b.webp` would be a device name or an alternate data stream
 * the moment anything wrote it to disk. The names the tooling generates go
 * through `mediaPublicPath`, which already asserts exactly these rules.
 */
export function isMediaObjectPath(value: string): boolean {
  const match = /^\/media\/[0-9a-f]{64}\/([^/]+)$/u.exec(value);
  if (match === null) return false;
  return isSafeRelativePath(match[1] ?? "");
}
