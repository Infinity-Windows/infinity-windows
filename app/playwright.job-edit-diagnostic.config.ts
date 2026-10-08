import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: /(?:job-phone-layout|job-edit-webkit-diagnostic)\.spec\.ts/,
  outputDir: process.env.IW_DIAG_OUT ?? "e2e/job-edit-diagnostic-results",
  workers: 1, fullyParallel: false, retries: 0, timeout: 90000,
  expect: { timeout: 30000 }, reporter: [["list"]],
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  use: { baseURL: "http://localhost:5297", viewport: {width:390,height:844}, deviceScaleFactor:2, trace:"on", video:"off" },
  webServer: { command:"npm run dev -- --port 5297 --strictPort", url:"http://localhost:5297", reuseExistingServer:false, timeout:120000,
    env: { VITE_SUPABASE_URL:"https://e2efixture.supabase.co", VITE_SUPABASE_ANON_KEY:"sb_publishable_e2e_fixture_not_a_secret" } },
});
