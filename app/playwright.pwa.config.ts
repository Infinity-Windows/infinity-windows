import { defineConfig } from "@playwright/test";

/**
 * The INSTALLED app, offline: a production build with its service worker.
 *
 * Every other spec runs against the Vite dev server, which never registers a
 * service worker (vite.config.ts, devOptions.enabled: false) and serves each
 * module on request, so none of them can see what a phone with no signal
 * actually has: the service worker's precache and nothing else. A chunk left
 * out of that precache passes every dev-server spec and still leaves a phone
 * reopened in a dead zone with a white screen. That happened (2026-09-25:
 * React inside the crash monitor's chunk, which the worker skips while
 * monitoring is off), so this config builds the real thing, serves it with
 * `vite preview`, and its specs go offline for real.
 *
 * Specs for it are named `*.pwa.ts`, which the dev-server config's default
 * pattern (`*.spec.ts`) never picks up, and vice versa.
 *
 * The build uses the same fixture project as playwright.config.ts — a host
 * that does not resolve and a placeholder key — so nothing here can reach the
 * real database. It lands in node_modules/.cache, not dist/, so it never
 * mixes with a build somebody is about to deploy or measure.
 */
const PORT = Number(process.env.IW_MAP_PORT ?? 5186);
const OUT = "node_modules/.cache/pwa-e2e-dist";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.pwa\.ts$/,
  outputDir: "./e2e/test-results",
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
    serviceWorkers: "allow",
    // A camera that exists, so the scanner's decoder can actually start —
    // which is the proof its chunk loaded — without a person to point it.
    permissions: ["camera"],
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  webServer: {
    command: `npx vite build --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // Never reuse by default: a production build does not hot-reload, so a
    // server left running is a build of older code. IW_PWA_REUSE=1 is for
    // aiming these specs at a build served by hand — the base branch's, say,
    // to watch a regression fail.
    reuseExistingServer: process.env.IW_PWA_REUSE === "1",
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      VITE_SUPABASE_URL: "https://e2efixture.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret",
    },
  },
});
