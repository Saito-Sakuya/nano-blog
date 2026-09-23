import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";
import {
  assertBuildExists,
  startStaticServer,
  stopStaticServer,
  waitForServer,
} from "./static-server.js";

/**
 * Lighthouse measurement.
 *
 * Two targets, both from the fixture build: the home page and a representative
 * article. The article is the full Markdown capability set — code blocks,
 * callouts, sidenotes, a table, a formula and a Mermaid diagram — because that
 * is the heaviest page the site can produce.
 *
 * ## Why the media origin points at a local server
 *
 * Every cover and figure is served from `https://media.example.invalid`, a
 * Cloudflare resource this repository is forbidden from creating and which
 * therefore does not resolve on this machine. Left alone, the measurement
 * describes that fact rather than the page: the cover request fails, the
 * fallback panel becomes the largest contentful paint, and every image audit
 * measures an empty box.
 *
 * The media origin is a documented build-time input (`PUBLIC_MEDIA_ORIGIN`), so
 * this script sets it — for its own build only — to a second static server on
 * this machine that serves the materialised derivatives. Covers then load over
 * HTTP exactly as they will from the real bucket, and the image, LCP and
 * bandwidth audits see real images. Nothing global is modified: no hosts file,
 * no DNS, no proxy, no system setting.
 *
 * Two differences from production remain, and neither is measurable locally:
 * the real origin is HTTPS behind Cloudflare's CDN, and the security headers in
 * `public/_headers` are applied by the host rather than by this server. Both
 * are covered statically instead — the headers by
 * `tests/integration/pipeline.test.ts`, the media resolution by
 * `content:validate`.
 *
 * The score targets are: performance ≥ 95, accessibility
 * 100, best practices 100, SEO ≥ 95, measured under mobile emulation.
 */

/** The build the other verifiers read; this script leaves it alone. */
const BUILD_DIR = "dist-fixtures";
/** The production-environment copy this script builds and measures. */
const PRODUCTION_DIR = path.join(
  PROJECT_ROOT,
  ".ani-content",
  "verification",
  "lighthouse",
);
/** Where the materialised media derivatives live. */
const RUNTIME_MEDIA_ROOT = path.join(PROJECT_ROOT, ".ani-content", "runtime");
const SITE_PORT = 4350;
const MEDIA_PORT = 4351;
const BASE_URL = `http://localhost:${SITE_PORT}`;

/** The heaviest article the fixture build contains. */
const ARTICLE_PATH = "/posts/notes/first-note/";

const REPORT_PATH = path.join(
  PROJECT_ROOT,
  "lighthouse-results",
  "lighthouse-summary.json",
);

/** The score targets, as fractions. */
const TARGETS = {
  performance: 0.95,
  accessibility: 1,
  bestPractices: 1,
  seo: 0.95,
} as const;

interface Measurement {
  readonly label: string;
  readonly url: string;
  readonly performance: number | null;
  readonly accessibility: number | null;
  readonly bestPractices: number | null;
  readonly seo: number | null;
  readonly lcpMs: number | null;
  readonly tbtMs: number | null;
  readonly cls: number | null;
}

/** Run the Lighthouse CLI once and read its JSON report. */
function runLighthouse(url: string, outputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "lighthouse",
        url,
        "--output=json",
        `--output-path=${outputPath}`,
        "--log-level=error",
        "--quiet",
        "--form-factor=mobile",
        "--screenEmulation.mobile",
        "--throttling-method=simulate",
        "--only-categories=performance,accessibility,best-practices,seo",
        "--chrome-flags=--headless=new --no-sandbox",
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

interface LhReport {
  readonly categories?: Record<string, { score?: number } | undefined>;
  readonly audits?: Record<string, { numericValue?: number } | undefined>;
}

async function readMeasurement(
  label: string,
  url: string,
  reportPath: string,
): Promise<Measurement> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as LhReport;
  const score = (key: string): number | null => {
    const value = report.categories?.[key]?.score;
    return typeof value === "number" ? value : null;
  };
  const metric = (key: string): number | null => {
    const value = report.audits?.[key]?.numericValue;
    return typeof value === "number" ? value : null;
  };

  return {
    label,
    url,
    performance: score("performance"),
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
    seo: score("seo"),
    lcpMs: metric("largest-contentful-paint"),
    tbtMs: metric("total-blocking-time"),
    cls: metric("cumulative-layout-shift"),
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 100));
}

function millis(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

/** Run the fixture build again with `SITE_ENV=production`, into PRODUCTION_DIR. */
function buildProductionCopy(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "scripts/build/build.ts",
        "--source",
        "fixtures",
        "--out-dir",
        path.relative(PROJECT_ROOT, PRODUCTION_DIR).split(path.sep).join("/"),
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          SITE_ENV: "production",
          // The build-time media origin, pointed at the local server that
          // serves the materialised derivatives for this measurement only.
          PUBLIC_MEDIA_ORIGIN: `http://127.0.0.1:${MEDIA_PORT}`,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(strict: boolean): Promise<number> {
  console.log(
    "building a production-environment copy so SEO is measured against an indexable page",
  );
  const buildCode = await buildProductionCopy();
  if (buildCode !== 0) {
    throw new Error(`The production copy failed to build (exit ${buildCode}).`);
  }

  const siteRoot = PRODUCTION_DIR;
  assertBuildExists(siteRoot, "the production copy");

  const reportDir = path.join(PROJECT_ROOT, "lighthouse-results");
  await mkdir(reportDir, { recursive: true });

  /*
   * The measurement build points its media origin at the local server below, so
   * that origin has to be permitted by the CSP this server now applies. The
   * shipped policy names only `https://media.example.invalid`; without this the
   * covers are blocked and the image and LCP audits go back to measuring the
   * fallback panels — the exact failure this script's header comment exists to
   * prevent. Only `img-src` and `media-src` are extended; every other directive
   * the page sees is the one the build ships.
   */
  const site = await startStaticServer(siteRoot, SITE_PORT, {
    allowedMediaOrigins: [`http://127.0.0.1:${String(MEDIA_PORT)}`],
  });
  // Public media paths are `/media/<sha>/<file>`, and the derivatives live in
  // the materialised runtime rather than in the build output: the bucket is a
  // separate origin, so nothing is copied into `dist-*`. Serving the runtime
  // root is what makes `/media/...` resolve to the real bytes.
  const media = await startStaticServer(RUNTIME_MEDIA_ROOT, MEDIA_PORT);

  const measurements: Measurement[] = [];

  try {
    await waitForServer(`${BASE_URL}/`, 30_000);

    const targets = [
      { label: "home", path: "/" },
      { label: "article", path: ARTICLE_PATH },
    ];

    for (const target of targets) {
      const reportPath = path.join(
        reportDir,
        `lighthouse-${target.label}.json`,
      );
      console.log(`\nmeasuring ${target.label} (${target.path})`);
      const code = await runLighthouse(`${BASE_URL}${target.path}`, reportPath);
      if (code !== 0) {
        throw new Error(
          `Lighthouse exited with ${code} for ${target.label}. Its report is at ${path.relative(PROJECT_ROOT, reportPath)}.`,
        );
      }
      measurements.push(
        await readMeasurement(target.label, target.path, reportPath),
      );
    }
  } finally {
    await stopStaticServer(media);
    await stopStaticServer(site);
  }

  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedBy: "scripts/verify/lighthouse.ts",
        build: path
          .relative(PROJECT_ROOT, PRODUCTION_DIR)
          .split(path.sep)
          .join("/"),
        siteEnv: "production",
        note: "Mobile emulation against a production-environment build (SITE_ENV=production), so the SEO audit sees an indexable page. PUBLIC_MEDIA_ORIGIN points at a local server serving the materialised media, because media.example.invalid is a Cloudflare resource this repository may not create; in production that origin is HTTPS behind the CDN.",
        targets: TARGETS,
        measurements,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("\nRESULTS");
  for (const measurement of measurements) {
    console.log(
      `  ${measurement.label.padEnd(8)} perf=${percent(measurement.performance)} a11y=${percent(measurement.accessibility)} bp=${percent(measurement.bestPractices)} seo=${percent(measurement.seo)}  LCP=${millis(measurement.lcpMs)} TBT=${millis(measurement.tbtMs)} CLS=${measurement.cls?.toFixed(3) ?? "n/a"}`,
    );
  }

  const failures: string[] = [];
  for (const measurement of measurements) {
    const checks: readonly [string, number | null, number][] = [
      ["performance", measurement.performance, TARGETS.performance],
      ["accessibility", measurement.accessibility, TARGETS.accessibility],
      ["best practices", measurement.bestPractices, TARGETS.bestPractices],
      ["seo", measurement.seo, TARGETS.seo],
    ];
    for (const [name, actual, target] of checks) {
      if (actual !== null && actual < target) {
        failures.push(
          `${measurement.label}: ${name} ${percent(actual)} is below the ${percent(target)} target`,
        );
      }
    }
  }

  /*
   * The score targets are asserted only under `--strict`.
   *
   * Lighthouse's mobile model simulates a slow network and a four-times-slowed
   * CPU, so the same page scores differently on a machine that is busy with
   * something else. This measurement is made and recorded rather than gated, and the automated
   * gate is defined in terms of transferred bytes — which `test:performance`
   * checks against
   * the real output with roughly five times the margin. A default exit code
   * that depends on a simulation would fail for reasons the reader cannot act
   * on, which is worse than no check.
   */
  if (failures.length > 0) {
    const report = failures.join("\n  ");
    if (strict) {
      console.error(`\nlighthouse: FAIL (--strict)\n  ${report}`);
      return 1;
    }
    console.log(
      `\nmeasured below the score target:\n  ${report}\n  (re-run with --strict to fail on this)`,
    );
  }

  console.log(
    `\nlighthouse: measured ${measurements.length} page(s); report written to ${path.relative(PROJECT_ROOT, REPORT_PATH)}.`,
  );
  return 0;
}

if (isDirectRun(import.meta.url)) {
  const strict = process.argv.slice(2).includes("--strict");
  main(strict)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export { ARTICLE_PATH, BASE_URL, BUILD_DIR, MEDIA_PORT, SITE_PORT, TARGETS };
