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
const PORT = Number(process.env.IW_MAP_PORT ?? 5173);

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
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // A host that does not resolve, with a placeholder key: the client is
    // configured, the storage key is stable, and a request that escaped the
    // fixture router could not reach the real project even by accident.
    env: {
      VITE_SUPABASE_URL: "https://e2efixture.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret",
    },
  },
});
