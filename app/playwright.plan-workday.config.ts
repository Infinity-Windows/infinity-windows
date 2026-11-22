import { defineConfig } from "@playwright/test";
import base from "./playwright.job-planner.config";
export default defineConfig({ ...base, testMatch: "plan-workday.spec.ts", outputDir: "./.test-temp/plan-workday-results" });
