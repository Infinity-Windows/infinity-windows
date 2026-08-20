// Bulk remove (owner, 2026-08-20): a bad extraction leaves N wrong marks, and
// removing them one confirm at a time is N trips through the same dialog. The
// review screen's "Remove several…" sweep selects marks and removes them in
// one confirmed pass, through the same remove_opening RPC with all its guards.
import { test, expect } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";

// The sweep only offers planned marks (installed ones refuse server-side
// anyway), so pick a fixture job that has at least two to select.
const job = jobFixtures().find(
  (j) => openingsFor(j.projectId).filter((o) => o.status === "planned").length >= 2,
)!;

test("a foreman removes several openings in one confirmed sweep", async ({
  page,
}) => {
  expect(job, "a fixture job with 2+ planned openings").toBeTruthy();
  await useSupabaseFixtures(page, { role: "foreman" });

  const removedIds: string[] = [];
  await page.route("**/rest/v1/rpc/remove_opening", async (route) => {
    const body = route.request().postDataJSON() as { p_opening_id: string };
    removedIds.push(body.p_opening_id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/rest/v1/rpc/list_removed_openings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  page.on("dialog", (d) => void d.accept());

  await page.goto(`/projects/${job.projectId}/review`);
  await page.getByRole("button", { name: "Remove several…" }).click();

  const boxes = page.locator('.opening-review-row input[type="checkbox"]');
  await boxes.first().check();
  await boxes.nth(1).check();
  await page.getByRole("button", { name: "Remove 2 selected" }).click();

  // One sweep, two RPC calls, and the outcome said in plain words.
  await expect(page.locator(".error")).toContainText("Removed 2 openings");
  expect(removedIds).toHaveLength(2);
  expect(new Set(removedIds).size).toBe(2);
});
