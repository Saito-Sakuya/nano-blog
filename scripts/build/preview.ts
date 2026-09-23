import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";

/**
 * Serve a built output directory locally.
 *
 * `pnpm preview` serves the normal build and `pnpm preview:fixtures` serves the
 * fixture build. Both are local inspection tools; neither is a deployment.
 */

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf("--dir");
const dir = dirIndex === -1 ? "dist" : (argv[dirIndex + 1] ?? "dist");

const target = path.resolve(PROJECT_ROOT, dir);
if (!existsSync(path.join(target, "index.html"))) {
  console.error(
    `${dir} has no index.html. Build it first: ${dir === "dist-fixtures" ? "pnpm build:fixtures" : "pnpm build"}.`,
  );
  process.exit(2);
}

console.log(`previewing ${dir} at http://localhost:4321/`);

const child = spawn(
  "npx",
  ["astro", "preview", "--outDir", dir, "--port", "4321"],
  {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
