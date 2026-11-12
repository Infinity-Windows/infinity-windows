import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "job-planner.spec.ts", workers: 1, timeout: 60000,
  outputDir: "./.test-temp/job-planner-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:5194", viewport: { width: 1100, height: 950 }, launchOptions: { channel: "chrome" } },
  webServer: { command: "npm run dev -- --mode steel-preview --host 127.0.0.1 --port 5194 --strictPort", url: "http://127.0.0.1:5194", reuseExistingServer: false, timeout: 120000, env: { VITE_SUPABASE_URL: "https://e2efixture.supabase.co", VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret" } },
});
