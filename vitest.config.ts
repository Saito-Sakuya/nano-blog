import { defineConfig } from "vitest/config";

/**
 * Unit and integration tests.
 *
 * Browser-driven tests live in Playwright (`tests/e2e`) and are run by
 * `pnpm test:e2e`; this runner covers pure logic and anything that can be
 * checked without a browser.
 *
 * `BUILD_NOW` is pinned so visibility decisions are deterministic. Without it a
 * test that publishes an article "tomorrow" would pass or fail depending on the
 * hour it ran.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    env: {
      BUILD_NOW: "2026-09-15T00:00:00.000Z",
      SITE_ENV: "local",
      SITE_URL: "https://blog.example.invalid",
      PUBLIC_MEDIA_ORIGIN: "https://media.example.invalid",
      SITE_TIME_ZONE: "Asia/Taipei",
    },
    // The build writes into `.ani-content`, which several suites share; running
    // files in parallel would have them overwrite each other's scratch state.
    fileParallelism: false,
  },
});
