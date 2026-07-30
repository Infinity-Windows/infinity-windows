import { defineConfig } from "@playwright/test";

/**
 * The foreman controls, driven against the real database as a real foreman.
 *
 * Deliberately NOT the fixture harness in playwright.config.ts. That one
 * replays committed JSON and never signs in, which is right for measuring the
 * map's layout and useless for the question this config exists to answer:
 * does dragging a mark, pressing Undo and putting the marks back actually
 * work, end to end, for somebody holding a foreman login?
 *
 * Three fixes shipped with that unanswered, because the only test login was an
 * installer and installers cannot move marks. Manufacturing changes on a real
 * customer's job to find out was never an acceptable answer, so the answer is
 * a foreman test login the database will not let out of the sandbox job. See
 * docs/test-account.md.
 *
 * Its own port, and its own port on purpose: 5173 is the dev server a human is
 * watching, and a run that restarts or reloads it is a run that interrupts
 * somebody's afternoon.
 */
const PORT = Number(process.env.IW_FOREMAN_PORT ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /foreman-[a-z]+\.spec\.ts/,
  outputDir: "./e2e/test-results-foreman",
  fullyParallel: false,
  workers: 1,
  // Signing in for real and loading a plan-set PDF over the network is slower
  // than replaying a fixture, and a timeout here reads as a broken control.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // A phone. This is a field app; the crew are not on a desktop, and a drag
    // that only works with a mouse on a wide screen is not a working drag.
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
    // Inherited from the caller, which reads them from the same place the app
    // does. Nothing is written to a file and nothing is printed.
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "",
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? "",
    },
  },
});
