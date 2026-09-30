import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

test("foreman can read a photo suggestion without the AI signing off QC", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const openingId = "20000000-0000-4000-8000-000000000041";
  const projectId = "20000000-0000-4000-8000-000000000042";
  const opening = {
    id: openingId, project_id: projectId, opening_code: "B14", status: "installed",
    assigned_window_id: null, window_types: { type_code: "W-1" },
    qc: null, projects: { job_code: "DEMO-01" },
  };
  await page.route("**/rest/v1/qc_checks**", (route) => json(route, []));
  await page.route("**/rest/v1/project_openings**", (route) => json(route, [opening], 1));
  let reviewCalls = 0;
  await page.route("**/functions/v1/review-qc-photo", (route) => {
    reviewCalls++;
    expect(route.request().postDataJSON()).toEqual({ openingId });
    return json(route, {
      openingId, photoId: "photo-1", photoCreatedAt: "2026-09-30T12:00:00Z",
      review: {
        summary: "The window is seated in the opening.",
        visible_checks: ["The lower frame is visible."],
        questions_for_foreman: ["Check the sill pan in person."],
        limitation: "One photo cannot show concealed flashing.",
      },
    });
  });
  await page.goto("/qc");
  await expect(page.getByText("B14")).toBeVisible();
  await page.getByRole("button", { name: "AI photo review" }).click();
  await expect(page.getByText("Check the sill pan in person.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pass ✓" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Callback" })).toBeVisible();
  expect(reviewCalls).toBe(1);
});
