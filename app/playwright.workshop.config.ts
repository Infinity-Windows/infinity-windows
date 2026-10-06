import { defineConfig } from "@playwright/test";
import { homedir } from "node:os";
import { join } from "node:path";

// Real, isolated workshop Auth/DB. No fixture server or request interception.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "workshop-real-accounts.workshop.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: join(homedir(), ".config/forge-workshop/browser-test-results"),
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5278",
    viewport: { width: 390, height: 844 },
    trace: "off",
    video: "off",
  },
});
