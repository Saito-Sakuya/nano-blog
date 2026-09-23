import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import * as pagefind from "pagefind";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";

/**
 * Build the static search index.
 *
 * Runs after `astro build` against the finished output directory, because
 * Pagefind indexes HTML files and there is no HTML until the build has run.
 *
 * Only elements marked `data-pagefind-body` are indexed — article bodies and
 * standalone pages — so navigation, footers, code-copy buttons, table-of-
 * contents links and sidenote chrome never turn up as search results.
 */

export interface SearchIndexOptions {
  /** Directory holding the built site. Defaults to `dist`. */
  readonly dir?: string;
  readonly log: (message: string) => void;
}

export interface SearchIndexResult {
  readonly outputPath: string;
  readonly files: number;
  readonly bytes: number;
}

function parseDirArg(argv: readonly string[]): string {
  const index = argv.indexOf("--dir");
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? "dist";
}

export async function buildSearchIndex(
  options: SearchIndexOptions,
): Promise<SearchIndexResult> {
  const siteDir = path.resolve(PROJECT_ROOT, options.dir ?? "dist");
  if (!existsSync(siteDir)) {
    throw new Error(
      `Cannot index ${siteDir}: it does not exist. Run the Astro build first.`,
    );
  }

  const outputPath = path.join(siteDir, "_pagefind");

  const { index } = await pagefind.createIndex({ forceLanguage: "zh-cn" });
  if (index === undefined) {
    throw new Error("Pagefind did not return an index.");
  }

  const indexed = await index.addDirectory({ path: siteDir });
  if (indexed.errors !== undefined && indexed.errors.length > 0) {
    throw new Error(
      `Pagefind reported ${indexed.errors.length} error(s): ${indexed.errors.join("; ")}`,
    );
  }

  await index.writeFiles({ outputPath });
  await pagefind.close();

  const stats = measure(outputPath);
  if (stats.files === 0) {
    throw new Error(`Pagefind wrote no files to ${outputPath}.`);
  }

  options.log(
    `search index: ${indexed.page_count ?? 0} page(s) → ${path.relative(PROJECT_ROOT, outputPath)} (${stats.files} file(s), ${stats.bytes} bytes)`,
  );

  return { outputPath, files: stats.files, bytes: stats.bytes };
}

/** Total file count and byte size under a directory. */
function measure(directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = measure(full);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }

  return { files, bytes };
}

const entry = process.argv[1];
if (entry !== undefined && entry.endsWith("search-index.ts")) {
  const dir = parseDirArg(process.argv.slice(2));
  await buildSearchIndex({ dir, log: (message) => console.log(message) });
}
