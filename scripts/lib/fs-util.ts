import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { ValidationError } from "./errors.js";
import {
  assertInsideDirectory,
  assertSafeRelativePath,
  resolveWithin,
} from "./safe-paths.js";

/**
 * Filesystem helpers shared by the author commands.
 *
 * Two rules are enforced here rather than at each call site:
 *
 * - **No shell.** Deleting is `fs.rm`, moving is `fs.rename`. Nothing is ever
 *   passed through a shell, so a path containing a quote or a space cannot turn
 *   into a second command.
 * - **Everything temporary is declared.** Staging and backup directories are
 *   created next to their target and are asserted to live inside the root the
 *   caller names, so a failed run cannot remove something outside
 *   `.ani-content`.
 */

export interface FileEntry {
  /** POSIX-separated path relative to the directory that was walked. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

export async function readTextFile(target: string): Promise<string> {
  return readFile(target, "utf8");
}

export async function readBytes(target: string): Promise<Uint8Array> {
  return readFile(target);
}

/** Read and parse JSON, reporting the file and the reason on failure. */
export async function readJsonFile(target: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError(`${target} does not exist.`);
    }
    throw new ValidationError(`Could not read ${target}: ${messageOf(error)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ValidationError(
      `${target} is not valid JSON: ${messageOf(error)}`,
    );
  }
}

/** Pretty JSON with a trailing newline — the form every generated file uses. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write a file through a temporary sibling and a rename, so a reader never sees
 * a half-written document and a crash cannot truncate an existing one.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  try {
    await writeFile(temporary, data);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonFile(
  target: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(target, formatJson(value));
}

/** Remove a file or a directory tree. Never routed through a shell. */
export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** Remove a path only after proving it is inside `root`. */
export async function removeInsideRoot(
  root: string,
  target: string,
): Promise<void> {
  assertInsideDirectory(root, target, `Refusing to remove ${target}`);
  await removePath(target);
}

/**
 * Walk a directory and return every regular file.
 *
 * Symbolic links — to a file, to a directory, or broken — are rejected rather
 * than followed: a link is how content escapes the directory it claims to be
 * in, and the release format has no way to express one.
 */
export async function listFilesRecursive(
  root: string,
  options: { readonly skipDirectories?: readonly string[] } = {},
): Promise<FileEntry[]> {
  const skip = new Set(options.skipDirectories ?? []);
  const entries: FileEntry[] = [];

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    const children = await readdir(absoluteDir, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      const absolute = path.join(absoluteDir, child.name);
      const relative =
        relativeDir.length === 0 ? child.name : `${relativeDir}/${child.name}`;

      if (child.isSymbolicLink()) {
        throw new ValidationError(
          `${relative} is a symbolic link. Content and media trees must contain regular files only.`,
        );
      }

      if (child.isDirectory()) {
        if (skip.has(child.name)) continue;
        await walk(absolute, relative);
        continue;
      }

      if (!child.isFile()) {
        throw new ValidationError(`${relative} is not a regular file.`);
      }

      const info = await stat(absolute);
      entries.push({
        relativePath: relative,
        absolutePath: absolute,
        bytes: info.size,
      });
    }
  }

  await walk(root, "");
  return entries;
}

/** SHA-256 of a file, streamed so a large media original is not read whole. */
export async function sha256File(target: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve();
    });
  });
  return hash.digest("hex");
}

/**
 * Replace `target` with `staging` as close to atomically as a directory rename
 * allows.
 *
 * The previous directory is moved aside first because Windows refuses to rename
 * onto a non-empty directory. If the swap fails, the previous directory is put
 * back, so the caller either has the old state or the new one — never neither,
 * and never a mixture.
 */
export async function replaceDirectoryAtomically(options: {
  readonly staging: string;
  readonly target: string;
  readonly root: string;
  readonly label: string;
}): Promise<void> {
  const { staging, target, root, label } = options;
  assertInsideDirectory(root, staging, `${label}: staging directory`);
  assertInsideDirectory(root, target, `${label}: target directory`);

  const parent = path.dirname(target);
  await ensureDirectory(parent);

  const previous = path.join(
    parent,
    `.${path.basename(target)}.previous-${process.pid}-${randomUUID().slice(0, 8)}`,
  );

  const hadTarget = await pathExists(target);
  if (hadTarget) await rename(target, previous);

  try {
    await rename(staging, target);
  } catch (error) {
    if (hadTarget) {
      await rename(previous, target).catch(() => undefined);
    }
    throw error;
  }

  if (hadTarget) {
    await removePath(previous).catch(() => undefined);
  }
}

/**
 * Run `body` with a fresh staging directory, removing it afterwards whether the
 * body succeeded or failed.
 */
export async function withStagingDirectory<T>(
  options: { readonly parent: string; readonly prefix: string },
  body: (staging: string) => Promise<T>,
): Promise<T> {
  await ensureDirectory(options.parent);
  const staging = path.join(
    options.parent,
    `.${options.prefix}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  await ensureDirectory(staging);

  try {
    return await body(staging);
  } finally {
    await removePath(staging).catch(() => undefined);
  }
}

export interface CopyFileEntriesOptions {
  /**
   * The directory every `relativePath` is relative to.
   *
   * When it is supplied, the source path is re-derived here from
   * `relativePath` — the same string that was validated — and the entry's own
   * `absolutePath` is not read at all. Callers that walked the tree themselves
   * should always pass it; omitting it is supported only for callers that
   * cannot name a single root, and falls back to a consistency check on
   * `absolutePath`.
   */
  readonly sourceRoot?: string;
  /**
   * Refuse to copy a file larger than this. The size is read from the file's
   * metadata *before* its bytes are, so a file that lies about its size in the
   * entry cannot be pulled into memory.
   */
  readonly maxBytes?: number;
}

/**
 * True when `absolutePath` really ends in the validated `relativePath`.
 *
 * Used only when no `sourceRoot` was supplied. It is weaker than re-resolving
 * the path — the prefix is taken on trust — but it does refuse an entry whose
 * two halves describe different files, which is the shape a hand-built
 * `FileEntry` smuggled in from a manifest takes.
 */
function entryPathsAgree(entry: FileEntry): boolean {
  const expected = entry.relativePath.split("/");
  const actual = path
    .resolve(entry.absolutePath)
    .split(path.sep)
    .slice(-expected.length);

  return (
    actual.length === expected.length &&
    actual.every((segment, index) => segment === expected[index])
  );
}

/**
 * Copy a known file list into `targetRoot`, creating directories as needed.
 *
 * The path that is *checked* and the path that is *read* are the same value:
 * `relativePath` is validated, then resolved under `sourceRoot` to produce the
 * absolute path. Reading `entry.absolutePath` instead — as this function used
 * to — left the two free to disagree, so an entry pairing a harmless
 * `relativePath` with `absolutePath: "C:/Windows/System32/config/SAM"` passed
 * every check and copied the file it named.
 *
 * The size is checked before the read, so the per-file limit the caller names
 * cannot be bypassed by handing over an entry that understates `bytes`.
 */
export async function copyFileEntries(
  targetRoot: string,
  entries: readonly FileEntry[],
  options: CopyFileEntriesOptions = {},
): Promise<void> {
  for (const entry of entries) {
    assertSafeRelativePath(entry.relativePath, "Copy source");

    let source: string;
    if (options.sourceRoot === undefined) {
      if (!entryPathsAgree(entry)) {
        throw new ValidationError(
          `Copy source ${JSON.stringify(entry.relativePath)} does not match its own absolute path ${entry.absolutePath}; refusing to copy a file the entry does not describe.`,
        );
      }
      source = entry.absolutePath;
    } else {
      source = resolveWithin(
        options.sourceRoot,
        entry.relativePath,
        "Copy source",
      );
    }

    const info = await stat(source);
    if (!info.isFile()) {
      throw new ValidationError(
        `${entry.relativePath} is not a regular file; refusing to copy it.`,
      );
    }
    if (options.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new ValidationError(
        `${entry.relativePath} is ${info.size} bytes, above the ${options.maxBytes}-byte limit for a copied file.`,
      );
    }

    const destination = path.join(targetRoot, ...entry.relativePath.split("/"));
    assertInsideDirectory(targetRoot, destination, "Copy destination");
    await ensureDirectory(path.dirname(destination));
    await writeFileAtomic(destination, await readFile(source));
  }
}

/** `1234567` → `1.2 MiB`, for human-readable summaries. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex] ?? "KiB"}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
