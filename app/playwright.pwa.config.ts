import { defineConfig } from "@playwright/test";

/**
 * The INSTALLED app: a production build with its service worker, offline and
 * across a deploy.
 *
 * Every other spec runs against the Vite dev server, which never registers a
 * service worker (vite.config.ts, devOptions.enabled: false) and serves each
 * module on request, so none of them can see what a phone actually has: the
 * service worker's precache and nothing else. A chunk left out of that
 * precache passes every dev-server spec and still leaves a phone reopened in
 * a dead zone with a white screen. That happened (2026-09-25: React inside
 * the crash monitor's chunk, which the worker skips while monitoring is off),
 * and the FIX for it went further: the deploy that shipped it turned every
 * phone on the previous build black, because their old worker's entry asked
 * the network for a file the new deploy no longer had — something no fresh
 * profile and no dev server could show, only a device carrying yesterday's
 * worker into today's deploy.
 *
 * So this config serves real builds through e2e/support/pwaHarness.ts: the
 * build phones are running (origin/master, or IW_PWA_OLD_REF) and this tree,
 * switchable per test on one origin, with the same caching headers GitHub
 * Pages sends. Specs for it are named `*.pwa.ts`, which the dev-server
 * config's default pattern (`*.spec.ts`) never picks up, and vice versa.
 *
 *   npx playwright test --config playwright.pwa.config.ts
 *
 * To watch upgrade-path.pwa.ts fail the way 2026-09-25 did, deploy a "new"
 * build without the file old phones ask for:
 *
 *   IW_PWA_DROP=assets/monitoring-BsbA4Bc6.js npx playwright test --config playwright.pwa.config.ts upgrade-path
 *
 * The harness builds with the same fixture project as playwright.config.ts —
 * a host that does not resolve and a placeholder key — so nothing here can
 * reach the real database. Builds land in node_modules/.cache, not dist/, so
 * they never mix with a build somebody is about to deploy or measure.
 */
const PORT = Number(process.env.IW_MAP_PORT ?? 5186);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.pwa\.ts$/,
  outputDir: "./e2e/test-results",
  fullyParallel: false,
  workers: 1,
  // A worker install precaches ~8 MB, and the loop spec waits out
  // workbox-window's one-minute "own update" window on top of that.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    video: "off",
    serviceWorkers: "allow",
  },
  webServer: {
    command: "node --experimental-strip-types e2e/support/pwaHarness.ts",
    url: `http://localhost:${PORT}/`,
    // Never reuse by default: a production build does not hot-reload, so a
    // server left running is a build of older code. IW_PWA_REUSE=1 keeps the
    // last run's two builds AND a harness already listening, for iterating
    // on a spec without two rebuilds each time.
    reuseExistingServer: process.env.IW_PWA_REUSE === "1",
    // Two production builds before the first request is answered.
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
