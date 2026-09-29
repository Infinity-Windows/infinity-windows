// The iPhone map used to open both PDFs and scan every page before drawing
// one sheet. This fixture asserts the worker can reach the original plan
// first and request the specs only when they tap it.
import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const BLACK22 = jobFixtures().find((job) => job.jobCode === "BLACK22")!;

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

test("phone Sheets opens one plan, then loads specs on demand", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 150]);
  pdf.addPage([200, 150]);
  const bytes = Buffer.from(await pdf.save());
  await page.route("**/rest/v1/project_plansets**", (route) => json(route, [
    { id: "00000000-0000-4000-8000-000000000a01", project_id: BLACK22.projectId,
      storage_path: `${BLACK22.projectId}/phone-building.pdf`, source_format: "pdf",
      converted_pdf_path: null, page_count: 2, status: "ready", kind: "building" },
    { id: "00000000-0000-4000-8000-000000000a02", project_id: BLACK22.projectId,
      storage_path: `${BLACK22.projectId}/phone-specs.pdf`, source_format: "pdf",
      converted_pdf_path: null, page_count: 2, status: "ready", kind: "specs" },
  ], 2));
  const downloaded: string[] = [];
  await page.route("**/storage/v1/object/**", (route) => {
    downloaded.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/pdf", body: bytes });
  });
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive&mapview=sheets`);
  await expect(page.locator(".plan-map--with-dots img")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Plan pages" }).getByRole("button", { name: "▶" }).click();
  await expect(page.locator('img[alt="Building plan PDF page 2"]')).toBeVisible();
  expect(downloaded.some((url) => url.includes("phone-building.pdf"))).toBe(true);
  expect(downloaded.some((url) => url.includes("phone-specs.pdf"))).toBe(false);
  await page.getByRole("button", { name: "Window & door details" }).click();
  await expect.poll(() => downloaded.some((url) => url.includes("phone-specs.pdf"))).toBe(true);
  await expect(page.locator(".plan-map--pdf-sketch img")).toBeVisible();
});
