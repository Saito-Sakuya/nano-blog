import { spawn } from "node:child_process";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import {
  detectSource,
  parseSourceArg,
  prepare,
  type ContentSource,
} from "./prepare.js";

/**
 * Start the development server.
 *
 * `pnpm dev` uses the author's workspace when one exists and the empty state
 * otherwise; `pnpm dev:fixtures` always uses the isolated test content and
 * announces that it has done so, so a fixture session can never be mistaken for
 * the real site.
 */

const argv = process.argv.slice(2);
const requested = parseSourceArg(argv);
const source: ContentSource = requested ?? (await detectSource());

await prepare({
  source,
  log: (message) => console.log(message),
});

if (source === "fixtures") {
  console.log("");
  console.log(
    "  TEST MODE — serving tests/fixtures/content, not real content.",
  );
  console.log('  Fixture articles are marked "TEST FIXTURE" in their titles.');
  console.log("");
}

const child = spawn("npx", ["astro", "dev"], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // The site reads this to label the environment in its own UI.
    ANI_NANO_SOURCE: source,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
