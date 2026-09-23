import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import { createApiStub } from "../verify/api-stub.js";
import {
  assertBuildExists,
  startStaticServer,
} from "../verify/static-server.js";

/**
 * `pnpm dev:api` — serve a build with the comment API attached.
 *
 * ## Why this exists instead of working in `astro dev`
 *
 * Pages Functions are a Cloudflare runtime feature. Serving them locally means
 * running the Worker runtime, which for an Astro project means the
 * `@astrojs/cloudflare` adapter — and adopting an adapter is exactly what this
 * project's specification forbids: the site is generated entirely at build time
 * and ships no server code of its own.
 *
 * Three ways of grafting the Functions onto `astro dev` were tried and all
 * failed, each for a structural reason worth recording so nobody repeats the
 * search:
 *
 * 1. Astro's `astro:server:setup` hook registers middleware, but it runs *after*
 *    Astro has already decided no route matches, so `/api/...` is answered by
 *    Astro's 404.
 * 2. An integration with `configureServer` at the top level is silently ignored,
 *    because Astro reads only the `hooks` object.
 * 3. A Vite plugin registered through `updateConfig` *is* loaded and its
 *    `configureServer` does run, but middleware registered there still loses to
 *    Astro's router.
 *
 * So this serves the built site instead. It is the same arrangement the
 * end-to-end tests use, it needs no adapter, and it runs the same handlers that
 * deploy — `createApiStub` imports them from `functions/lib/` and only storage
 * differs.
 *
 * Usage: build the fixtures once, then run this.
 *
 * ```
 * pnpm build:fixtures
 * pnpm dev:api
 * ```
 *
 * Development only. The production path is `build:pages`, which is untouched by
 * any of this.
 */

/** Deliberately not 4321 or 4322, so both tests and preview can run at once. */
const PORT = 4390;

/**
 * The fixtures build, which is what `pnpm build:fixtures` writes.
 *
 * It used to point at `.ani-content/preview`, a directory no script in this
 * repository creates — so the two-command usage above could not work from a
 * clean checkout: the server started and served nothing. `dist-fixtures` is the
 * output the documented command actually produces, so the instruction and the
 * behaviour now agree. Nothing else read that path, and nothing writes here:
 * the server is read-only, so serving the same directory the end-to-end tests
 * use is a read they can share.
 */
const BUILD_DIR = "dist-fixtures";

export async function devApi(): Promise<void> {
  const root = path.join(PROJECT_ROOT, BUILD_DIR);
  assertBuildExists(root, BUILD_DIR);

  const stub = createApiStub();
  await startStaticServer(root, PORT, {
    handleRequest: (request, address) => stub.handle(request, address),
  });

  console.log(
    `serving ${path.relative(process.cwd(), root)} at http://localhost:${String(PORT)}/`,
  );
  console.log("the comment API is mounted over an in-memory store");
  console.log(
    "comments and view counts are per-process and disappear on restart",
  );
}

if (isDirectRun(import.meta.url)) {
  await devApi();
}
