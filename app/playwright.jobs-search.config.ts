import { defineConfig } from "@playwright/test";

/**
 * The Jobs page's search bar, chips, schedule highlight and the Office order
 * toggle — fixture-driven, like playwright.config.ts, never a real login.
 *
 * Its own port, dedicated to this one spec file: the shared config's port is
 * already spoken for by the job-map/job-cards/job-pipeline specs, and an
 * agent running this in a worktree must not restart a dev server somebody
 * else (or another spec run) is mid-test against.
 */
const PORT = Number(process.env.IW_JOBS_SEARCH_PORT ?? 5197);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /jobs-search\.spec\.ts/,
  outputDir: "./e2e/test-results-jobs-search",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // Same placeholder fixture host playwright.config.ts uses: configured, but
    // unreachable, so a request that escaped the route fixtures below could
    // never reach the real project even by accident.
    env: {
      VITE_SUPABASE_URL: "https://e2efixture.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret",
    },
  },
});
