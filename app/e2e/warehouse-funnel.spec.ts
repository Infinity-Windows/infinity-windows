// The warehouse funnel (wave F, grill Q5/Q6): the hub's top reads as five
// numbered stations in the order material moves, and every destination page
// wears a chip naming which station it belongs to. Driven through the real
// UI at phone width, same as the rest of the storage suite.
import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("the hub shows five stations in order, and the old duplicate delivery link is gone", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/warehouse");

  await expect(page.getByRole("heading", { name: "Where is it" })).toBeVisible();

  const names = await page.locator(".station-name").allTextContents();
  expect(names).toEqual([
    "Coming in",
    "Off the truck",
    "Put away",
    "Out the door",
    "Fix a mistake",
  ]);

  // The hub used to list "Deliveries — check trucks in" twice — once in a
  // quick-link row, once again inside the "Coming in" section. The redesign
  // folds both into station 1's one link.
  await expect(page.getByRole("link", { name: "Deliveries — check trucks in" })).toHaveCount(1);
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
