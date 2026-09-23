import { defineConfig, devices } from "@playwright/test";

/**
 * The browser to drive.
 *
 * `chrome` uses the copy of Google Chrome installed on the machine rather than
 * Playwright's own download. That is deliberate: the final acceptance pass is
 * meant to be made in the system browser, and it also means the
 * suite runs in the environment a reader actually has.
 */
const CHANNEL = process.env["E2E_CHANNEL"] ?? "chrome";
const EMPTY_PASS = process.env["E2E_EMPTY"] === "1";

/**
 * Temporary workaround for microsoft/playwright#42731.
 *
 * `public/_headers` deliberately sends `Cross-Origin-Opener-Policy:
 * same-origin`. Playwright 1.63.0's Firefox build can replace the first page's
 * browsing context for that policy while reusing a Juggler channel identifier;
 * a cached protocol response then swallows `navigationCommitted`, leaving
 * `page.goto` pending after the document has loaded. The upstream fix is merged
 * but is not in a stable Playwright release yet.
 *
 * This preference disables the broken context replacement in the test-only
 * Firefox process. The deployed header is unchanged, the integration suite
 * still checks its exact value, and Chromium/WebKit continue to enforce it.
 * Remove this preference once the project upgrades to a stable Playwright
 * release containing the upstream fix.
 */
const FIREFOX_USER_PREFS = {
  "browser.tabs.remote.useCrossOriginOpenerPolicy": false,
};

/**
 * Browser tests.
 *
 * The projects mirror the four viewports chosen for visual
 * acceptance — 360×800, 768×1024, 1280×900 and 1536×960 — so the same suite
 * covers the phone, tablet, desktop and wide cases rather than testing one and
 * assuming the rest.
 *
 * Served builds are started by the `test:e2e` wrapper, which brings up the
 * empty build on 4321 and the fixture build on 4322 before the suite runs.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: EMPTY_PASS ? "site.spec.ts" : "**/*.spec.ts",
  outputDir: process.env["PLAYWRIGHT_OUTPUT_DIR"] ?? "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  /*
   * Per-test budget.
   *
   * Playwright's default is 30 seconds, which is generous for an assertion and
   * tight for WebKit on a machine that is busy with something else: a single
   * `page.goto` on this suite has been observed to take longer than that under
   * load, and because every navigation shares the budget, one slow page turns
   * into a project-wide cascade of timeouts that reads as dozens of broken
   * tests. Raising it does not weaken any assertion — a test that fails still
   * fails — it only stops slow navigation from being reported as a defect.
   */
  timeout: 90_000,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder:
          process.env["PLAYWRIGHT_HTML_OUTPUT_DIR"] ?? "playwright-report",
      },
    ],
  ],

  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:4321",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "mobile-360",
      use: {
        ...devices["Desktop Chrome"],
        channel: CHANNEL,
        viewport: { width: 360, height: 800 },
      },
    },
    {
      name: "tablet-768",
      use: {
        ...devices["Desktop Chrome"],
        channel: CHANNEL,
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        channel: CHANNEL,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "wide-1536",
      use: {
        ...devices["Desktop Chrome"],
        channel: CHANNEL,
        viewport: { width: 1536, height: 960 },
      },
    },

    // The three engines the supported-browser policy names. Firefox and WebKit
    // run at one representative desktop viewport rather than all four: the
    // layout matrix is covered by the Chromium projects above, and what these
    // add is engine coverage, not another pass over the same breakpoints.
    {
      name: "firefox-1280",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: FIREFOX_USER_PREFS },
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "webkit-1280",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
