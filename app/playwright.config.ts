import { defineConfig } from "@playwright/test";

/**
 * Phone-sized screenshot harness for the job map.
 *
 * 390 × 844 at deviceScaleFactor 2 is an iPhone 14/15 — the screen the map has
 * to be readable on, and the width the redesign is measured against. Everything
 * the app would ask Supabase for is replayed from committed fixtures (see
 * e2e/support/supabaseFixtures.ts), so this needs no login, no token, and no
 * network.
 *
 * The dev server is reused when one is already running, so this does not fight
 * the `iwdev` session on 5173. Set `IW_MAP_PORT` to run on a port of your own
 * instead — an agent checking a change in a worktree must not reload the server
 * somebody is watching.
 */
// A DEDICATED e2e port, never 5173: the webServer below runs with the
// fixture env, and squatting on the owner's iwdev port once served him a
// fixture-backed app ("Wrong database", 2026-08-14). A separate port also
// keeps the fixture guarantee honest — reusing a real-env server would
// let an escaped request reach the real project.
const PORT = Number(process.env.IW_MAP_PORT ?? 5183);

// IW_E2E_BUILT=1 serves one production build of the app instead of the dev
// server. CI sets it. The dev server hands the browser every source module on
// its own, hundreds of requests a page, from one Node process, and every test
// opens a fresh browser with nothing cached: about three seconds a test before
// it does anything, across 330 tests, and close to three times that once four
// browsers shared that one process (measured 2026-11-25). A build is a few
// files. It is also nearer to what a phone runs, with one deliberate
// difference: its service worker is blocked below, because a request a worker
// makes never reaches the fixture router and would look for the real network.
// The installed app, worker included, has its own config (playwright.pwa.config.ts).
// Left unset, as on a laptop, nothing changes: the dev server, reused if running.
const BUILT = process.env.IW_E2E_BUILT === "1";
// Beside the installed-app harness's builds, never dist/ (see that config).
const BUILT_DIR = "node_modules/.cache/e2e-built";

export default defineConfig({
  testDir: "./e2e",
  // Traces/videos for a failed run. Screenshots we keep are written explicitly
  // into e2e/__screenshots__ by the spec, so they survive a clean.
  outputDir: "./e2e/test-results",
  fullyParallel: false,
  workers: 1,
  // Reading a 4 MB planset PDF in the browser is the slow part of every test.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    // `localhost`, not `127.0.0.1`: Vite binds to ::1 only by default.
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    video: "off",
    ...(BUILT ? { serviceWorkers: "block" as const } : {}),
  },
  webServer: {
    command: BUILT
      ? `npx vite build --outDir ${BUILT_DIR} --emptyOutDir && npx vite preview --outDir ${BUILT_DIR} --port ${PORT} --strictPort`
      : `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    // The build comes first when BUILT, and a runner takes about a minute over it.
    timeout: BUILT ? 300_000 : 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // A host that does not resolve, with a placeholder key: the client is
    // configured, the storage key is stable, and a request that escaped the
    // fixture router could not reach the real project even by accident.
    env: {
      VITE_SUPABASE_URL: "https://e2efixture.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret",
      // Exercise owner Live Chat against fixtures, never a real AI session.
      VITE_LIVE_ASK_PILOT: "true",
    },
  },
});
