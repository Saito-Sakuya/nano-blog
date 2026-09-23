import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import { createApiStub } from "./api-stub.js";
import {
  assertBuildExists,
  startStaticServer,
  stopStaticServer,
  waitForServer,
} from "./static-server.js";

/**
 * Browser suite orchestration (`pnpm test:e2e`).
 *
 * Two builds, two passes:
 *
 * | Pass          | Build                                     | Port | Environment                         | Spec files           |
 * | ------------- | ----------------------------------------- | ---- | ----------------------------------- | -------------------- |
 * | full          | `.ani-content/verification/e2e/fixtures` | 4322 | `E2E_CHANNEL=chrome`                | both                 |
 * | empty         | `.ani-content/verification/e2e/empty`    | 4321 | `E2E_CHANNEL=chrome`, `E2E_EMPTY=1` | `tests/e2e/site.spec.ts` |
 *
 * The empty pass is the same document-shell suite pointed at a build with no
 * content in it, which is how "the site works before the first article is
 * published" is actually tested rather than assumed. `content.spec.ts` skips
 * itself there: it has no content to exercise. The copies are built here with
 * a loopback media origin, so an unavailable placeholder hostname can never
 * make Firefox wait on DNS while a page is navigating.
 *
 * `E2E_CHANNEL=chrome` is set here rather than left to the default, because the
 * suite is required to run in the browser the reader actually has. Firefox and
 * WebKit are only run when Playwright's own copies are present.
 *
 * ## The server
 *
 * The project's own preview server (`scripts/build/preview.ts`) is not
 * usable from here. Astro 7 detects that it is running under an agent and moves
 * `astro preview` into the background, where it takes a single global lock and
 * refuses `--ignore-lock`; a second preview cannot be started, and a child
 * process cannot own the first one. So the two builds are served by the small
 * static server below instead: `index.html` for a directory URL, a 404 status
 * with `404.html` for anything else, and correct content types — which is
 * exactly what Cloudflare Pages does for this build, and therefore what the
 * suite means when it asks for `/rss.xml` or `/_pagefind/pagefind.js`.
 *
 * The server is defined here and only here. `a11y.ts` and `visual.ts` start
 * their own copy because this change is limited to the set of files that
 * may be created; a shared module is the obvious refactor once that limit is
 * lifted.
 */

const FIXTURE_PORT = 4322;
const EMPTY_PORT = 4321;
const MEDIA_PORT = 4323;
const MEDIA_ORIGIN = `http://127.0.0.1:${MEDIA_PORT}`;
const PLAYWRIGHT_CLI = path.join(
  PROJECT_ROOT,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const TSX_CLI = path.join(
  PROJECT_ROOT,
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);

const E2E_BUILD_ROOT = path.join(
  PROJECT_ROOT,
  ".ani-content",
  "verification",
  "e2e",
);
const RUNTIME_MEDIA_ROOT = path.join(PROJECT_ROOT, ".ani-content", "runtime");

const SERVERS: readonly {
  readonly label: string;
  readonly source: "empty" | "fixtures";
  readonly dir: string;
  readonly port: number;
}[] = [
  {
    label: "empty",
    source: "empty",
    dir: path.join(E2E_BUILD_ROOT, "empty"),
    port: EMPTY_PORT,
  },
  {
    label: "fixtures",
    source: "fixtures",
    dir: path.join(E2E_BUILD_ROOT, "fixtures"),
    port: FIXTURE_PORT,
  },
];

/** Run the project's Playwright CLI and resolve with its exit code. */
function runPlaywright(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", ...args],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env,
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Build one E2E copy without overwriting the builds other checks inspect. */
function buildE2eCopy(
  source: "empty" | "fixtures",
  outputDirectory: string,
): Promise<number> {
  const outputDirectoryFromRoot = path
    .relative(PROJECT_ROOT, outputDirectory)
    .split(path.sep)
    .join("/");

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [
        TSX_CLI,
        "scripts/build/build.ts",
        "--source",
        source,
        "--out-dir",
        outputDirectoryFromRoot,
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          PUBLIC_MEDIA_ORIGIN: MEDIA_ORIGIN,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  console.log(
    `building isolated E2E copies with loopback media at ${MEDIA_ORIGIN}`,
  );
  for (const { label, source, dir } of SERVERS) {
    const buildCode = await buildE2eCopy(source, dir);
    if (buildCode !== 0) {
      throw new Error(`The ${label} E2E build failed (exit ${buildCode}).`);
    }
    assertBuildExists(dir, `${label} E2E build`);
  }

  const started: { label: string; server: Server; port: number }[] = [];
  const results: { pass: string; code: number }[] = [];
  let media: Server | undefined;

  /*
   * The comment and view API is mounted in front of both builds.
   *
   * One stub instance per build so the fixture pass and the empty pass cannot
   * see each other's submissions: a comment posted against the fixture build
   * must not appear in the empty build's assertions. Both instances serve the
   * production handlers over `MemoryCommentStore`.
   */
  try {
    /*
     * The build emits a preconnect for this configured origin. Serving both
     * that connection and the materialised media on loopback keeps the browser
     * suite independent of external DNS and lets normal navigations finish.
     * Tests that exercise the fallback panel install their own 404 route, so
     * that failure injection cannot affect unrelated Firefox page loads.
     */
    media = await startStaticServer(RUNTIME_MEDIA_ROOT, MEDIA_PORT);
    await waitForServer(`${MEDIA_ORIGIN}/`, 30_000);

    for (const { label, dir, port } of SERVERS) {
      const stub = createApiStub({ rateLimits: null, buildRoot: dir });
      const server = await startStaticServer(dir, port, {
        allowedMediaOrigins: [MEDIA_ORIGIN],
        handleRequest: (request, address) => stub.handle(request, address),
      });
      started.push({ label, server, port });
      console.log(
        `serving ${path.relative(PROJECT_ROOT, dir)} at http://localhost:${port}/ (${label}) with the comments API`,
      );
    }

    for (const { label, port } of started) {
      await waitForServer(`http://localhost:${port}/`, 30_000);
      console.log(`${label} build answered on port ${port}`);
    }

    // Forwarded so a single project or spec can be run while iterating:
    // `pnpm test:e2e -- --project=desktop-1280`.
    const forwarded = process.argv.slice(2);

    const baseEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_CHANNEL: process.env["E2E_CHANNEL"] ?? "chrome",
      E2E_MEDIA_ORIGIN: MEDIA_ORIGIN,
    };

    console.log("\n--- pass 1/2: the fixture build (full suite) ---");
    results.push({
      pass: "fixtures",
      code: await runPlaywright(forwarded, {
        ...baseEnvironment,
        E2E_BASE_URL: `http://localhost:${FIXTURE_PORT}`,
        PLAYWRIGHT_OUTPUT_DIR: path.join(
          PROJECT_ROOT,
          "test-results",
          "fixtures",
        ),
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(
          PROJECT_ROOT,
          "playwright-report",
          "fixtures",
        ),
      }),
    });

    console.log("\n--- pass 2/2: the empty build (site shell only) ---");
    results.push({
      pass: "empty",
      code: await runPlaywright(
        [...forwarded, "tests/e2e/site.spec.ts", "--pass-with-no-tests"],
        {
          ...baseEnvironment,
          E2E_EMPTY: "1",
          E2E_BASE_URL: `http://localhost:${EMPTY_PORT}`,
          PLAYWRIGHT_OUTPUT_DIR: path.join(
            PROJECT_ROOT,
            "test-results",
            "empty",
          ),
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(
            PROJECT_ROOT,
            "playwright-report",
            "empty",
          ),
        },
      ),
    });
  } finally {
    for (const { server } of started) await stopStaticServer(server);
    if (media !== undefined) await stopStaticServer(media);
  }

  console.log("\ne2e summary:");
  for (const result of results) {
    console.log(
      `  ${result.pass.padEnd(9)} ${result.code === 0 ? "PASS" : `FAIL (exit ${result.code})`}`,
    );
  }

  const failed = results.filter((result) => result.code !== 0);
  if (failed.length > 0) {
    console.error(`\ne2e: FAIL — ${failed.length} pass(es) failed.`);
    return 1;
  }

  console.log("\ne2e: PASS — both browser passes completed.");
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export { EMPTY_PORT, FIXTURE_PORT, runPlaywright };
