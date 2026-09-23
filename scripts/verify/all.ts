import { spawn } from "node:child_process";

import { PROJECT_ROOT } from "../../src/lib/content/paths.js";
import { isDirectRun } from "../lib/run.js";

/**
 * Run the whole verification sequence.
 *
 * Every step runs even when an earlier one fails, so a single invocation gives
 * the complete picture rather than stopping at the first problem. The summary
 * at the end is the thing to read; the exit code is non-zero if anything failed.
 *
 * The order matters in one direction: both builds must happen before the tests,
 * because the integration tests check built output and skip themselves when it
 * is absent — which is every fresh checkout, including CI. `test:e2e` starts and
 * stops its own servers so it runs alone.
 */

interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Whether exit code 2 means "could not run here" for this step.
   *
   * Opt-in per step rather than a property of the whole run. It used to apply to
   * every step, so any script that happened to return 2 was reported as SKIP and
   * the run still exited 0 — a blanket exemption that would hide a real failure
   * the day one returned that code for another reason.
   */
  readonly skippable?: true;
}

const STEPS: readonly Step[] = [
  { name: "format:check", command: "npx", args: ["prettier", "--check", "."] },
  { name: "lint", command: "npx", args: ["eslint", "."] },
  // The glob is not optional: with no arguments `markdownlint-cli2` lints zero
  // files and exits 0, so the step used to pass without reading anything.
  {
    name: "lint:markdown",
    command: "npx",
    args: ["markdownlint-cli2", "**/*.md"],
  },
  { name: "check", command: "npx", args: ["astro", "check"] },
  // The TypeScript half of the repository. `astro check` reads the root
  // tsconfig, which pulls in the framework types; this second pass points the
  // same strict preset at the scripts, tests and config files so a type error
  // in a build script — where the framework types do not apply — cannot hide
  // behind a passing component check.
  {
    name: "check:types",
    command: "npx",
    args: ["tsc", "--noEmit", "-p", "tsconfig.scripts.json"],
  },
  /*
   * Both builds come before the tests, and that order is load-bearing.
   *
   * `tests/integration/pipeline.test.ts` checks built output: it reads
   * `dist-fixtures/index.html` and skips its describes when the file is absent.
   * Both build directories are git-ignored, so on a fresh checkout — which is
   * what CI is — running `test` first skipped five describes and reported a green
   * suite that had checked nothing. Every local run passed because the
   * directories happened to exist from an earlier build.
   */
  { name: "build", command: "npx", args: ["tsx", "scripts/build/build.ts"] },
  {
    name: "build:fixtures",
    command: "npx",
    args: ["tsx", "scripts/build/build.ts", "--source", "fixtures"],
  },
  { name: "test", command: "npx", args: ["vitest", "run"] },
  /*
   * The content gate, over the fixtures.
   *
   * This is the check that refuses a release: URL rules, redirects, media
   * references, heading anchors, frontmatter. It was only ever run by hand, so
   * the one gate every release is documented to pass through was not part of the
   * automated chain at all.
   *
   * Without `--publication`, deliberately. That flag makes an unresolvable media
   * record an error, and it can only resolve against the media index a release
   * carries — locally there is none, so every cover in the fixtures would be an
   * error and the step could never pass. `content:publish` runs the publication
   * check where it can actually succeed. What this step adds here is everything
   * that is decidable from the source alone, run on every change instead of
   * whenever someone remembered.
   */
  {
    name: "content:validate",
    command: "npx",
    args: ["tsx", "scripts/content/validate-cmd.ts", "--source", "fixtures"],
  },
  {
    name: "test:links",
    command: "npx",
    args: ["tsx", "scripts/verify/links.ts"],
  },
  { name: "test:e2e", command: "npx", args: ["tsx", "scripts/verify/e2e.ts"] },
  {
    name: "test:a11y",
    command: "npx",
    args: ["tsx", "scripts/verify/a11y.ts"],
  },
  {
    name: "test:visual",
    command: "npx",
    args: ["tsx", "scripts/verify/visual.ts"],
  },
  {
    name: "test:performance",
    command: "npx",
    args: ["tsx", "scripts/verify/performance.ts"],
  },
  // Needs a headed browser: a headless one uses overlay scrollbars, which take
  // no space, so the layout shift this looks for cannot happen there. Reports
  // exit 2 when it cannot get a window, which the summary prints as SKIP.
  {
    name: "test:nav",
    command: "npx",
    args: ["tsx", "scripts/verify/nav-stability.ts"],
    skippable: true,
  },
];

function runStep(step: Step): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(step.command, [...step.args], {
      cwd: PROJECT_ROOT,
      shell: process.platform === "win32",
      env: process.env,
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (error) =>
      resolve({ code: 1, output: `${output}\n${error.message}` }),
    );
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function main(): Promise<number> {
  const results: {
    name: string;
    code: number;
    output: string;
    skippable: boolean;
  }[] = [];

  console.log(
    `verifying ${STEPS.length} steps — every step runs even if an earlier one fails\n`,
  );

  for (const [index, step] of STEPS.entries()) {
    console.log(
      `\n${"=".repeat(72)}\n[${index + 1}/${STEPS.length}] ${step.name}\n${"=".repeat(72)}`,
    );

    const result = await runStep(step);
    results.push({
      name: step.name,
      skippable: step.skippable === true,
      ...result,
    });

    // The step's own output is echoed so a failure can be read in context
    // rather than only as a name in the summary.
    process.stdout.write(
      result.output.endsWith("\n") ? result.output : `${result.output}\n`,
    );
    console.log(
      `→ ${step.name}: ${result.code === 0 ? "PASS" : `FAIL (exit ${result.code})`}`,
    );
  }

  const failed = results.filter((result) => result.code !== 0);
  /*
   * Exit 2 means "could not run here", which is not the same as a failure — but
   * only for a step that says so. `test:nav` needs a headed browser, because a
   * headless one uses overlay scrollbars and cannot reproduce the condition it
   * checks, so on a machine without a display it reports that honestly. Folding
   * it into PASS would be the vacuous gate this project has already been bitten
   * by; folding it into FAIL would make the whole chain red for an environment
   * reason; and treating *any* step's exit 2 that way would silently excuse a
   * real failure the day some other script returned it.
   */
  const isSkipped = (result: { code: number; skippable: boolean }): boolean =>
    result.code === 2 && result.skippable;
  const skipped = failed.filter(isSkipped);
  const broken = failed.filter((result) => !isSkipped(result));

  console.log(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
  for (const result of results) {
    const status =
      result.code === 0 ? "PASS" : isSkipped(result) ? "SKIP" : "FAIL";
    console.log(`  ${status}  ${result.name}`);
  }

  const skippedNote =
    skipped.length === 0
      ? ""
      : ` (${skipped.length} could not run here: ${skipped.map((s) => s.name).join(", ")})`;

  if (broken.length === 0) {
    console.log(
      skipped.length === 0
        ? `\nAll ${results.length} steps passed.`
        : `\nAll runnable steps passed; ${skipped.length} skipped: ${skipped.map((s) => s.name).join(", ")}.`,
    );
    return 0;
  }

  console.log(
    `\n${broken.length} of ${results.length} step(s) failed: ${broken.map((f) => f.name).join(", ")}${skippedNote}`,
  );
  return 1;
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
