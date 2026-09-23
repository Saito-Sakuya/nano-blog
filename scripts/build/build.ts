import { spawn } from "node:child_process";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import {
  readSourceRecord,
  type SourceRecord,
} from "../../src/lib/content/source-record.js";
import { runPull } from "../content/pull.js";
import { EXIT, type ExitCode } from "../lib/errors.js";
import { isDirectRun } from "../lib/run.js";
import {
  prepare,
  detectSource,
  parseSourceArg,
  type ContentSource,
} from "./prepare.js";
import { buildSearchIndex } from "./search-index.js";
import { postbuild } from "./postbuild.js";

/**
 * The production build pipeline.
 *
 *   materialise one content source → astro build → search index → post-build checks
 *
 * Nothing here contacts Cloudflare or writes to a bucket. `build:pages` pulls a
 * release from R2 through `content:pull`, which is a read-only operation, and
 * the rest of the pipeline is entirely local.
 */

type BuildKind = "default" | "fixtures" | "pages";

interface BuildOptions {
  readonly kind: BuildKind;
  readonly source: ContentSource;
  readonly outDir: string;
  readonly log: (message: string) => void;
}

export interface PagesPullDependencies {
  readonly pull?: () => Promise<ExitCode>;
  readonly readSource?: () => SourceRecord | null;
}

/** Run a command, inheriting stdio, and fail the pipeline if it fails. */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
  });
}

/**
 * Assert the environment a pages build requires.
 *
 * `SITE_ENV` is the only thing that decides whether the result may be indexed.
 * Both Pages environments must also name explicit HTTPS origins for canonical
 * URLs and media; accepting a credential, path or query here would bake it into
 * every generated page.
 */
export function assertHttpsOriginVariable(name: string): string {
  const raw = process.env[name];
  let value: URL;
  try {
    value = new URL(raw ?? "");
  } catch {
    throw new Error(
      `build:pages requires ${name} to be an https origin, but it is ${JSON.stringify(raw ?? null)}.`,
    );
  }

  if (
    raw !== raw?.trim() ||
    value.protocol !== "https:" ||
    value.username !== "" ||
    value.password !== "" ||
    value.pathname !== "/" ||
    value.search !== "" ||
    value.hash !== "" ||
    value.origin === "null"
  ) {
    throw new Error(
      `build:pages requires ${name} to be an https origin with no credentials, path, query or fragment, but it is ${JSON.stringify(raw ?? null)}.`,
    );
  }
  return value.origin;
}

export function assertPagesEnvironment(): void {
  const siteEnv = process.env["SITE_ENV"];
  if (siteEnv !== "production" && siteEnv !== "preview") {
    throw new Error(
      `build:pages requires SITE_ENV to be "production" or "preview", but it is ${JSON.stringify(siteEnv ?? null)}.`,
    );
  }

  assertHttpsOriginVariable("SITE_URL");
  assertHttpsOriginVariable("PUBLIC_MEDIA_ORIGIN");
}

/**
 * Pull and verify the active R2 release before a Pages build starts.
 *
 * Both operations are injectable so this boundary can be tested without R2 or
 * the repository's real runtime directory. A successful CLI exit is not enough
 * by itself: the source record must prove that the atomic runtime swap produced
 * an R2 release rather than leaving an older workspace/fixture runtime behind.
 */
export async function pullPagesRuntime(
  dependencies: PagesPullDependencies = {},
): Promise<SourceRecord> {
  const code = await (dependencies.pull ?? (() => runPull([])))();
  if (code !== EXIT.OK) {
    throw new Error(
      `build:pages could not pull the active R2 release (content:pull exited with code ${code}).`,
    );
  }

  const source = (dependencies.readSource ?? readSourceRecord)();
  if (
    source === null ||
    source.mode !== "r2" ||
    source.releaseId === null ||
    source.contentDigest === null
  ) {
    throw new Error(
      "build:pages pulled content but no complete R2 source record was materialised; refusing to build a stale or partial runtime.",
    );
  }
  return source;
}

export async function build(options: BuildOptions): Promise<void> {
  const { kind, source, outDir, log } = options;

  if (kind === "pages") {
    assertPagesEnvironment();
    const pulled = await pullPagesRuntime();
    log(`content source: r2 release ${pulled.releaseId}`);
  } else {
    const result = await prepare({ source, log });
    if (result.posts === 0) {
      log("no content yet — building the empty state");
    }
  }

  await run("npx", ["astro", "build", "--outDir", outDir], {
    ...process.env,
    ANI_NANO_SOURCE: source,
  });

  await buildSearchIndex({ dir: outDir, log });
  await postbuild({ dir: outDir, kind, log });

  log(`build complete: ${outDir}`);
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `--out-dir <dir>` redirects the output directory.
 *
 * Only the verification scripts use this: a measurement that needs a
 * production-environment build (so the site is actually indexable) must not
 * overwrite the `dist-fixtures` that the other checks read. It is not a way to
 * change what gets deployed — `build:pages` always writes `dist`, and that
 * path ignores this flag.
 */
function parseOutDir(args: readonly string[]): string | null {
  const index = args.indexOf("--out-dir");
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--out-dir needs a directory name.");
  }
  // Never allow a path that escapes the repository.
  if (value.includes("..") || value.startsWith("/") || value.includes(":")) {
    throw new Error(
      `--out-dir must be a plain directory name inside the repository, but received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export async function runBuild(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const fixtureBuild =
    argv.includes("--source") &&
    argv[argv.indexOf("--source") + 1] === "fixtures";
  const pagesBuild = argv.includes("--site-env-from-env");
  const requested = parseSourceArg(argv);
  const outDirOverride = parseOutDir(argv);

  if (outDirOverride !== null && pagesBuild) {
    throw new Error("--out-dir cannot be combined with build:pages.");
  }

  if (pagesBuild) {
    await build({
      kind: "pages",
      source: "r2",
      outDir: "dist",
      log: console.log,
    });
  } else if (fixtureBuild) {
    await build({
      kind: "fixtures",
      source: "fixtures",
      outDir: outDirOverride ?? "dist-fixtures",
      log: console.log,
    });
  } else {
    const source = requested ?? (await detectSource());
    await build({
      kind: "default",
      source,
      outDir: outDirOverride ?? "dist",
      log: console.log,
    });
  }
}

if (isDirectRun(import.meta.url)) {
  await runBuild();
}
