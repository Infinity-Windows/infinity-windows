// The warehouse home is the yard (wave 3): boxes drawn as boxes, one link to
// check trucks in, and every destination page still wears a station chip that
// leads back here (wave F's chips outlive wave F's strip). Driven through the
// real UI at phone width, same as the rest of the storage suite.
import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("the hub is the yard, and the delivery link appears exactly once", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/warehouse");
  await expect(page.getByRole("heading", { name: "Where is it" })).toBeVisible();
  await expect(page.getByRole("list", { name: "The yard" })).toBeVisible();
  await expect(page.getByRole("button", { name: /New container/ })).toBeVisible();
  // The hub used to list "Deliveries — check trucks in" twice. The yard keeps
  // exactly one, on the next-truck card.
  await expect(page.getByRole("link", { name: "Deliveries — check trucks in" })).toHaveCount(1);
  // No station strip any more.
  await expect(page.locator(".station-name")).toHaveCount(0);
});

test("a chip on Tag packages navigates back to the warehouse hub", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/storage/tag");
  const chip = page.getByRole("link", { name: "② Off the truck" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/\/warehouse$/);
  await expect(page.getByRole("heading", { name: "Where is it" })).toBeVisible();
});
